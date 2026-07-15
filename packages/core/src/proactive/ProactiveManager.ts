import { Cron } from 'croner';
import type { Watch } from '@workerking/shared';
import type { ProactiveNotice } from '../claude/tools.js';

export type { Watch };

/**
 * ProactiveManager — scheduled "watches" that let WorkerKing speak up unprompted.
 *
 * Each watch is a prompt run on a cron schedule against Claude (which can reach
 * the user's connected MCP servers, e.g. Google Calendar). If Claude judges there's
 * something worth interrupting for it returns a one-line heads-up → `notify`; if
 * not it returns the sentinel NONE and we stay quiet. Off by default (it spends
 * Claude quota on a timer); started only when `proactiveEnabled` is set.
 *
 * `respond` and the cron factory are injected so the logic is testable without a
 * real schedule or Claude.
 */
export interface ProactiveManagerDeps {
  respond: (prompt: string) => Promise<string>;
  notify: (notice: ProactiveNotice) => void;
  watches: Watch[];
  makeCron?: (expr: string, cb: () => void) => { stop: () => void };
}

const NONE = 'NONE';

/** The full watch set = built-in watches + the user's stored ones. */
export function composeWatches(store?: { list(): Watch[] }): Watch[] {
  return [...defaultWatches(), ...(store?.list() ?? [])];
}

/** The default watches shipped with WorkerKing. */
export function defaultWatches(): Watch[] {
  return [
    {
      id: 'calendar-heads-up',
      builtin: true,
      // Every 5 minutes; Claude decides whether anything is worth a heads-up.
      cron: '*/5 * * * *',
      prompt:
        'You are a proactive assistant. If the user has a calendar tool, check for events starting in ' +
        'the next 15 minutes. If there is one, reply with a single friendly spoken sentence (e.g. ' +
        `"Heads up — your 3pm sync starts in 10 minutes"). If nothing is worth interrupting them for, ` +
        `reply with exactly: ${NONE}`,
    },
  ];
}

/** Run a single watch; returns the heads-up text to speak, or undefined if none. */
export async function runWatch(
  watch: Watch,
  respond: (prompt: string) => Promise<string>,
): Promise<string | undefined> {
  const result = (await respond(watch.prompt)).trim();
  if (!result || result.toUpperCase() === NONE) return undefined;
  // Guard against the model wrapping NONE in punctuation/quotes.
  if (/^["'`]*none["'`.!]*$/i.test(result)) return undefined;
  return result;
}

export class ProactiveManager {
  private crons: Array<{ stop: () => void }> = [];
  private watches: Watch[];
  private running = false;
  private readonly makeCron: (expr: string, cb: () => void) => { stop: () => void };

  constructor(private readonly deps: ProactiveManagerDeps) {
    this.watches = deps.watches;
    this.makeCron =
      deps.makeCron ?? ((expr, cb) => new Cron(expr, () => cb()) as unknown as { stop: () => void });
  }

  start(): void {
    this.running = true;
    for (const watch of this.watches) {
      this.crons.push(this.makeCron(watch.cron, () => void this.tick(watch)));
    }
  }

  /** Replace the scheduled watches at runtime (add/remove), rescheduling if running. */
  reload(watches: Watch[]): void {
    this.watches = watches;
    if (!this.running) return;
    for (const c of this.crons) c.stop();
    this.crons = [];
    for (const watch of this.watches) {
      this.crons.push(this.makeCron(watch.cron, () => void this.tick(watch)));
    }
  }

  private async tick(watch: Watch): Promise<void> {
    try {
      const text = await runWatch(watch, this.deps.respond);
      if (text) this.deps.notify({ text, speak: true, source: `watch:${watch.id}` });
    } catch {
      // A failed watch shouldn't crash the daemon; stay quiet.
    }
  }

  stop(): void {
    this.running = false;
    for (const c of this.crons) c.stop();
    this.crons = [];
  }
}
