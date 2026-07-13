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

  it('ships a default calendar watch', () => {
    const watches = defaultWatches();
    expect(watches[0].id).toBe('calendar-heads-up');
    expect(watches[0].prompt).toContain('NONE');
  });
});
