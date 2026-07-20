import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReminderStore } from './ReminderStore.js';
import { ReminderScheduler } from './ReminderScheduler.js';
import { buildNotifyTool, buildReminderTool, type ProactiveNotice } from '../claude/tools.js';
import { ConfigStore } from '../config/ConfigStore.js';
import { FakeScreenContextProvider } from '../screen/ScreenContextProvider.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'wk-rem-'));
}

describe('ReminderStore', () => {
  it('adds, persists/reloads, lists pending + due, and cancels', () => {
    const t = 1000;
    const dir = tempDir();
    const store = new ReminderStore({ dir, now: () => t });
    store.add('drink water', 5000, 'r1');
    store.add('past thing', 500, 'r2'); // already due at t=1000

    const reloaded = new ReminderStore({ dir, now: () => t });
    expect(
      reloaded
        .pending()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['r1', 'r2']);
    expect(reloaded.due().map((r) => r.id)).toEqual(['r2']); // fireAt 500 <= now 1000

    reloaded.markFired('r2');
    expect(reloaded.pending().map((r) => r.id)).toEqual(['r1']);
    expect(reloaded.cancel('r1')).toBe(true);
    expect(reloaded.pending()).toHaveLength(0);
  });
});

describe('ReminderScheduler', () => {
  it('fires due reminders on start and arms future ones with a fake timer', () => {
    const t = 1000;
    const dir = tempDir();
    const store = new ReminderStore({ dir, now: () => t });
    store.add('now-due', 500, 'due');
    store.add('later', 3000, 'later');

    const fired: string[] = [];
    // Fake timer: capture the callback so the test can trigger it.
    let armedCb: (() => void) | undefined;
    const scheduler = new ReminderScheduler({
      store,
      now: () => t,
      onFire: (r) => fired.push(r.id),
      setTimer: (cb) => {
        armedCb = cb;
        return { clear: () => {} };
      },
    });
    scheduler.start();

    expect(fired).toContain('due'); // due one fired immediately
    expect(store.pending().map((r) => r.id)).toEqual(['later']);

    armedCb?.(); // simulate the timer elapsing for 'later'
    expect(fired).toContain('later');
  });

  it('re-arms (does not fire) a far-future reminder instead of firing early', () => {
    const t = 0;
    const dir = tempDir();
    const store = new ReminderStore({ dir, now: () => t });
    // 60 days out — well past the ~24.8-day setTimeout ceiling.
    store.add('far', 60 * 24 * 3600 * 1000, 'far');

    const fired: string[] = [];
    const delays: number[] = [];
    let cb: (() => void) | undefined;
    const scheduler = new ReminderScheduler({
      store,
      now: () => t,
      onFire: (r) => fired.push(r.id),
      setTimer: (c, ms) => {
        cb = c;
        delays.push(ms);
        return { clear: () => {} };
      },
    });
    scheduler.start();

    // First timer is capped (not the full 60-day delay), and firing it re-arms
    // rather than delivering the reminder.
    expect(delays[0]).toBeLessThanOrEqual(2_000_000_000);
    cb!();
    expect(fired).toEqual([]); // still not fired
    expect(delays.length).toBe(2); // re-armed with another capped timer
  });

  it('does not fire a reminder that is no longer pending (cancelled)', () => {
    let t = 1000;
    const dir = tempDir();
    const store = new ReminderStore({ dir, now: () => t });
    store.add('gone', 2000, 'gone');

    const fired: string[] = [];
    let cb: (() => void) | undefined;
    const scheduler = new ReminderScheduler({
      store,
      now: () => t,
      onFire: (r) => fired.push(r.id),
      setTimer: (c) => {
        cb = c;
        return { clear: () => {} };
      },
    });
    scheduler.start();

    store.cancel('gone'); // removed before the timer elapses
    t = 3000;
    cb!(); // timer fires after the fire time, but it's no longer pending
    expect(fired).toEqual([]);
  });
});

describe('notify + set_reminder tools', () => {
  function deps(overrides: Partial<Parameters<typeof buildReminderTool>[0]> = {}) {
    return {
      config: new ConfigStore(),
      screen: new FakeScreenContextProvider({ ok: true }),
      now: () => 10_000,
      ...overrides,
    };
  }

  it('notify emits a proactive notice', async () => {
    const notices: ProactiveNotice[] = [];
    const t = buildNotifyTool(deps({ proactiveNotify: (n) => notices.push(n) }));
    await t.handler({ text: 'Build finished', level: 'success', speak: true }, undefined);
    expect(notices[0]).toMatchObject({
      text: 'Build finished',
      level: 'success',
      source: 'notify-tool',
    });
  });

  it('set_reminder schedules a future reminder from delaySeconds', async () => {
    const schedule = vi.fn(() => 'rid-1');
    const t = buildReminderTool(deps({ scheduleReminder: schedule }));
    const r = await t.handler({ message: 'stretch', delaySeconds: 60 }, undefined);
    expect(r.isError).toBeUndefined();
    expect(schedule).toHaveBeenCalledWith('stretch', 10_000 + 60_000);
  });

  it('set_reminder rejects a non-future / missing time', async () => {
    const t = buildReminderTool(deps({ scheduleReminder: vi.fn() }));
    const r = await t.handler({ message: 'x' }, undefined);
    expect(r.isError).toBe(true);
  });

  it('set_reminder refuses when reminders are disabled', async () => {
    const t = buildReminderTool(
      deps({ config: new ConfigStore({ remindersEnabled: false }), scheduleReminder: vi.fn() }),
    );
    const r = await t.handler({ message: 'x', delaySeconds: 60 }, undefined);
    expect(r.isError).toBe(true);
  });
});
