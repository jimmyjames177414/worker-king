import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Cron } from 'croner';
import type { Watch } from '@workerking/shared';
import { writeJsonAtomic } from '../util/atomicJson.js';

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

/**
 * A cron expression is valid iff croner (the scheduler that will actually run
 * it) can parse it. Field-count alone is not enough: `"0 25 * * *"` has five
 * fields but throws at schedule time, and a persisted throwing watch would
 * poison every subsequent boot/reload of the ProactiveManager.
 */
export function isValidCron(expr: string): boolean {
  if (expr.trim().split(/\s+/).length !== 5) return false;
  try {
    // No callback → croner only parses the pattern; nothing is scheduled.
    new Cron(expr).stop();
    return true;
  } catch {
    return false;
  }
}

/** Keep only entries a schedule pass can safely consume (hand-edited files). */
function isValidWatch(w: unknown): w is Watch {
  const x = w as Watch;
  return (
    !!x &&
    typeof x === 'object' &&
    typeof x.id === 'string' &&
    typeof x.prompt === 'string' &&
    typeof x.cron === 'string' &&
    isValidCron(x.cron)
  );
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
    // Random suffix: an add/remove/add within one ms must not reuse an id
    // (a length-based suffix would, and remove(id) would then hit the wrong watch).
    this.newId =
      opts.newId ??
      (() => `watch-${Math.floor(this.now())}-${Math.random().toString(36).slice(2, 8)}`);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      // Validate each entry: a hand-edited/corrupt watch (bad cron, missing
      // fields) must not reach the scheduler, where it would throw at boot.
      if (Array.isArray(parsed?.watches)) this.watches = parsed.watches.filter(isValidWatch);
    } catch {
      // Corrupt file → start empty; the next write repairs it.
    }
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.path, { watches: this.watches });
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
    const watch: Watch = {
      id: this.newId(),
      prompt: prompt.trim(),
      cron: cron.trim(),
      builtin: false,
    };
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
