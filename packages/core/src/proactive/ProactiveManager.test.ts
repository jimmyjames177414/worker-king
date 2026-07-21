import { describe, it, expect, vi } from 'vitest';
import { ProactiveManager, runWatch, defaultWatches, type Watch } from './ProactiveManager.js';
import type { ProactiveNotice } from '../claude/tools.js';

const watch: Watch = { id: 'w', prompt: 'p', cron: '* * * * *' };

describe('runWatch', () => {
  it('returns the heads-up when Claude reports something', async () => {
    expect(await runWatch(watch, async () => 'Your 3pm starts in 10 minutes')).toBe(
      'Your 3pm starts in 10 minutes',
    );
  });
  it('returns undefined for the NONE sentinel (and quoted/punctuated variants)', async () => {
    expect(await runWatch(watch, async () => 'NONE')).toBeUndefined();
    expect(await runWatch(watch, async () => '  none. ')).toBeUndefined();
    expect(await runWatch(watch, async () => '"NONE"')).toBeUndefined();
    expect(await runWatch(watch, async () => '')).toBeUndefined();
  });
});

describe('ProactiveManager', () => {
  it('notifies only when a watch produces a heads-up', async () => {
    const notices: ProactiveNotice[] = [];
    let tick: (() => void) | undefined;
    const respond = vi
      .fn<(p: string) => Promise<string>>()
      .mockResolvedValueOnce('Heads up — standup in 5')
      .mockResolvedValueOnce('NONE');

    const mgr = new ProactiveManager({
      respond,
      notify: (n) => notices.push(n),
      watches: [watch],
      makeCron: (_expr, cb) => {
        tick = cb;
        return { stop: () => {} };
      },
    });
    mgr.start();

    tick!(); // first check → heads-up
    await new Promise((r) => setTimeout(r, 0));
    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain('standup');

    tick!(); // second check → NONE, stays quiet
    await new Promise((r) => setTimeout(r, 0));
    expect(notices).toHaveLength(1);
  });

  it('threads a watch timezone through to the cron factory', () => {
    const seen: Array<{ expr: string; opts?: { timezone?: string } }> = [];
    const mgr = new ProactiveManager({
      respond: async () => 'NONE',
      notify: () => {},
      watches: [
        { id: 'tz', prompt: 'p', cron: '0 9 * * 1-5', timezone: 'America/Chicago' },
        { id: 'no-tz', prompt: 'p', cron: '* * * * *' },
      ],
      makeCron: (expr, _cb, opts) => {
        seen.push({ expr, ...(opts ? { opts } : {}) });
        return { stop: () => {} };
      },
    });
    mgr.start();
    expect(seen[0].opts).toEqual({ timezone: 'America/Chicago' });
    expect(seen[1].opts).toBeUndefined();
  });

  it('skips a watch the scheduler rejects without dropping the ones after it', () => {
    // A bad cron OR a bad timezone throws out of the factory; one hand-edited
    // watch must not unschedule the rest.
    const scheduled: string[] = [];
    const mgr = new ProactiveManager({
      respond: async () => 'NONE',
      notify: () => {},
      watches: [
        { id: 'bad', prompt: 'p', cron: '0 9 * * 1-5', timezone: 'Not/AZone' },
        { id: 'good', prompt: 'p', cron: '* * * * *' },
      ],
      makeCron: (expr, _cb, opts) => {
        if (opts?.timezone === 'Not/AZone') throw new RangeError('invalid time zone');
        scheduled.push(expr);
        return { stop: () => {} };
      },
    });
    expect(() => mgr.start()).not.toThrow();
    expect(scheduled).toEqual(['* * * * *']);
  });

  it('ships a default sprint watch on a working-hours schedule', () => {
    const watches = defaultWatches();
    expect(watches[0].id).toBe('sprint-heads-up');
    expect(watches[0].cron).toBe('0 9-17 * * 1-5');
    expect(watches[0].timezone).toBe('America/Chicago');
    expect(watches[0].prompt).toContain('NONE');
    // It must reach the sprint tool, and must NOT re-report what SprintWatcher
    // already pushes over SSE (that would notify twice).
    expect(watches[0].prompt).toContain('mcp__workerking__get_standup_state');
    expect(watches[0].prompt).toMatch(/Do NOT report new, closed or reassigned/);
  });
});
