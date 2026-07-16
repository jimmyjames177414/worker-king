import { readFileSync, existsSync } from 'node:fs';
import { writeJsonAtomic } from '../util/atomicJson.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * ReminderStore — durable timers/reminders (file-based, mirrors MemoryStore).
 *
 * Reminders survive daemon restarts: pending ones reload on boot and the
 * scheduler re-arms them. Fired reminders are marked done (kept briefly for
 * audit) rather than deleted immediately.
 */
export interface Reminder {
  id: string;
  message: string;
  /** Epoch ms when it should fire. */
  fireAt: number;
  createdAt: number;
  fired?: boolean;
}

export interface ReminderStoreOptions {
  dir?: string;
  now?: () => number;
}

export class ReminderStore {
  private readonly path: string;
  private readonly dir: string;
  private readonly now: () => number;
  private reminders: Reminder[] = [];

  constructor(opts: ReminderStoreOptions = {}) {
    this.dir = opts.dir ?? join(homedir(), '.claude', 'workerking');
    this.path = join(this.dir, 'reminders.json');
    this.now = opts.now ?? (() => Date.now());
    this.load();
  }

  private load(): void {
    if (existsSync(this.path)) {
      try {
        const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
        if (Array.isArray(parsed?.reminders)) this.reminders = parsed.reminders;
      } catch {
        /* corrupt → start empty */
      }
    }
  }

  private persist(): void {
    writeJsonAtomic(this.path, { reminders: this.reminders });
  }

  add(message: string, fireAt: number, id: string): Reminder {
    const reminder: Reminder = { id, message, fireAt, createdAt: this.now() };
    this.reminders.push(reminder);
    this.persist();
    return reminder;
  }

  markFired(id: string): void {
    const r = this.reminders.find((x) => x.id === id);
    if (r) {
      r.fired = true;
      this.persist();
    }
  }

  /** Pending (not yet fired) reminders. */
  pending(): Reminder[] {
    return this.reminders.filter((r) => !r.fired);
  }

  /** Pending reminders already due (fireAt <= now) — used to catch up on boot. */
  due(): Reminder[] {
    const t = this.now();
    return this.pending().filter((r) => r.fireAt <= t);
  }

  cancel(id: string): boolean {
    const before = this.reminders.length;
    this.reminders = this.reminders.filter((r) => r.id !== id);
    if (this.reminders.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }
}
