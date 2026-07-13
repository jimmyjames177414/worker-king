import type { ReminderStore, Reminder } from './ReminderStore.js';

/**
 * ReminderScheduler — arms `setTimeout`s for pending reminders and fires them.
 *
 * On start it catches up any already-due reminders (missed while the daemon was
 * down) and arms timers for the rest. `onFire` is where the daemon turns a fired
 * reminder into a `proactive.notify` broadcast. The timer factory is injectable so
 * tests can drive it with a fake clock.
 */
export interface SchedulerDeps {
  store: ReminderStore;
  onFire: (reminder: Reminder) => void;
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => { clear: () => void };
}

export class ReminderScheduler {
  private readonly timers = new Map<string, { clear: () => void }>();
  private readonly now: () => number;
  private readonly setTimer: (cb: () => void, ms: number) => { clear: () => void };

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer =
      deps.setTimer ??
      ((cb, ms) => {
        const h = setTimeout(cb, ms);
        // Don't keep the process alive just for a reminder.
        (h as { unref?: () => void }).unref?.();
        return { clear: () => clearTimeout(h) };
      });
  }

  /** Fire due reminders now, then arm timers for the rest. */
  start(): void {
    for (const r of this.deps.store.due()) this.fire(r);
    for (const r of this.deps.store.pending()) this.arm(r);
  }

  /** Arm a single reminder (used by start + when a new one is added at runtime). */
  arm(reminder: Reminder): void {
    if (this.timers.has(reminder.id)) return;
    const delay = Math.max(0, reminder.fireAt - this.now());
    const timer = this.setTimer(() => this.fire(reminder), delay);
    this.timers.set(reminder.id, timer);
  }

  private fire(reminder: Reminder): void {
    this.timers.get(reminder.id)?.clear();
    this.timers.delete(reminder.id);
    if (this.deps.store.pending().some((r) => r.id === reminder.id) || reminder.fireAt <= this.now()) {
      this.deps.store.markFired(reminder.id);
      this.deps.onFire(reminder);
    }
  }

  cancel(id: string): void {
    this.timers.get(id)?.clear();
    this.timers.delete(id);
  }

  stop(): void {
    for (const t of this.timers.values()) t.clear();
    this.timers.clear();
  }
}
