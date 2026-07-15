import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Watch } from '@workerking/shared';

/**
 * WatchStore — durable, user-defined proactive watches.
 *
 * The built-in watches (defaultWatches) ship with WorkerKing; this holds the
 * ones the user adds, persisted under ~/.claude/workerking so they survive a
 * restart. File-backed like ReminderStore/MemoryStore. The daemon schedules
 * defaults + these.
 */

export interface WatchStoreOptions {
  dir?: string;
  now?: () => number;
  newId?: () => string;
}

/** A cron expression is valid enough if it has 5 whitespace-separated fields. */
export function isValidCron(expr: string): boolean {
  return expr.trim().split(/\s+/).length === 5;
}

export class WatchStore {
  private readonly path: string;
  private readonly now: () => number;
  private readonly newId: () => string;
  private watches: Watch[] = [];

  constructor(opts: WatchStoreOptions = {}) {
    const dir = opts.dir ?? join(homedir(), '.claude', 'workerking');
    this.path = join(dir, 'watches.json');
    this.now = opts.now ?? (() => Date.now());
    this.newId = opts.newId ?? (() => `watch-${Math.floor(this.now())}-${this.watches.length}`);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      if (Array.isArray(parsed?.watches)) this.watches = parsed.watches;
    } catch {
      // Corrupt file → start empty; the next write repairs it.
    }
  }

  private persist(): void {
    try {
      mkdirSync(join(this.path, '..'), { recursive: true });
      writeFileSync(this.path, JSON.stringify({ watches: this.watches }, null, 2), 'utf8');
    } catch {
      // Best-effort; never crash the daemon over a watch write.
    }
  }

  /** User watches (built-ins are added separately by the daemon). */
  list(): Watch[] {
    return this.watches.map((w) => ({ ...w }));
  }

  /** Add a user watch; throws on an invalid cron. Returns the created watch. */
  add(prompt: string, cron: string): Watch {
    if (!prompt.trim()) throw new Error('watch prompt is required');
    if (!isValidCron(cron)) throw new Error(`invalid cron expression: "${cron}"`);
    const watch: Watch = { id: this.newId(), prompt: prompt.trim(), cron: cron.trim(), builtin: false };
    this.watches.push(watch);
    this.persist();
    return watch;
  }

  /** Remove a user watch by id. Returns whether it existed. */
  remove(id: string): boolean {
    const i = this.watches.findIndex((w) => w.id === id);
    if (i < 0) return false;
    this.watches.splice(i, 1);
    this.persist();
    return true;
  }
}
