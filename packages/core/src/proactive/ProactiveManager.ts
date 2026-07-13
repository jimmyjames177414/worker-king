import { Cron } from 'croner';
import type { ProactiveNotice } from '../claude/tools.js';

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
export interface Watch {
  id: string;
  prompt: string;
  /** 5-field cron expression (min interval: hourly enforced by scheduler libs). */
  cron: string;
}

export interface ProactiveManagerDeps {
  respond: (prompt: string) => Promise<string>;
  notify: (notice: ProactiveNotice) => void;
  watches: Watch[];
  makeCron?: (expr: string, cb: () => void) => { stop: () => void };
}

const NONE = 'NONE';

/** The default watches shipped with WorkerKing. */
export function defaultWatches(): Watch[] {
  return [
    {
      id: 'calendar-heads-up',
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
  private readonly makeCron: (expr: string, cb: () => void) => { stop: () => void };

  constructor(private readonly deps: ProactiveManagerDeps) {
    this.makeCron =
      deps.makeCron ?? ((expr, cb) => new Cron(expr, () => cb()) as unknown as { stop: () => void });
  }

  start(): void {
    for (const watch of this.deps.watches) {
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
    for (const c of this.crons) c.stop();
    this.crons = [];
  }
}
