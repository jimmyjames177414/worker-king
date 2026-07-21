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
export interface CronOptions {
  /** IANA timezone the expression is evaluated in; omitted = daemon local time. */
  timezone?: string;
}

export interface ProactiveManagerDeps {
  respond: (prompt: string) => Promise<string>;
  notify: (notice: ProactiveNotice) => void;
  watches: Watch[];
  makeCron?: (expr: string, cb: () => void, opts?: CronOptions) => { stop: () => void };
}

const NONE = 'NONE';

/** The full watch set = built-in watches + the user's stored ones. */
export function composeWatches(store?: { list(): Watch[] }): Watch[] {
  return [...defaultWatches(), ...(store?.list() ?? [])];
}

/**
 * The default watches shipped with WorkerKing.
 *
 * One hourly sprint check during working hours. Scope matters here: SprintWatcher
 * already pushes real-time SSE notices for new/closed/reassigned items and guard
 * trips, so this watch must cover only what that stream does NOT — otherwise
 * every item change notifies twice.
 *
 * (This replaced a calendar watch that ran every 5 minutes — 288 Claude calls a
 * day — asking about a calendar tool that could never load: ClaudeBackend sets
 * `settingSources: []`, so no user MCP server is ever reachable from a watch. It
 * returned NONE every single time.)
 */
export function defaultWatches(): Watch[] {
  return [
    {
      id: 'sprint-heads-up',
      builtin: true,
      // Once an hour, 9am-5pm on weekdays: 9 checks a day, not 288.
      cron: '0 9-17 * * 1-5',
      // Pinned so a working-hours schedule survives travel or a TZ change.
      timezone: 'America/Chicago',
      prompt:
        'You are a proactive assistant checking on the user’s sprint. Call the ' +
        'mcp__workerking__get_standup_state tool and look at ONLY these three things:\n' +
        '1. Pull requests awaiting the user’s review (prs.reviewing).\n' +
        '2. The sprint finishing within the next two days (sprint.finishDate).\n' +
        '3. A broken or stale data feed: staleness.lastFetchOk === false, or ' +
        'staleness.lastFetch more than about 24 hours old.\n' +
        'Do NOT report new, closed or reassigned work items — those are already pushed to the user ' +
        'in real time by a separate watcher, and repeating them would notify twice.\n' +
        'If one of the three is worth a heads-up, reply with a single friendly spoken sentence ' +
        '(e.g. "Two PRs are waiting on your review"). If the tool errors, Sprint is not running, ' +
        `or nothing above applies, reply with exactly: ${NONE}`,
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
  /** Watches with a tick already in flight — a slow Claude call must not stack. */
  private readonly inFlight = new Set<string>();
  private readonly makeCron: (
    expr: string,
    cb: () => void,
    opts?: CronOptions,
  ) => { stop: () => void };

  constructor(private readonly deps: ProactiveManagerDeps) {
    this.watches = deps.watches;
    this.makeCron =
      deps.makeCron ??
      ((expr, cb, opts) =>
        new Cron(expr, opts ?? {}, () => cb()) as unknown as { stop: () => void });
  }

  start(): void {
    this.running = true;
    this.schedule();
  }

  /** Replace the scheduled watches at runtime (add/remove), rescheduling if running. */
  reload(watches: Watch[]): void {
    this.watches = watches;
    if (!this.running) return;
    for (const c of this.crons) c.stop();
    this.crons = [];
    this.schedule();
  }

  /**
   * Schedule every watch, skipping (not throwing on) any whose cron OR timezone
   * the scheduler rejects — one bad persisted watch must not take down the
   * daemon or unschedule the watches after it.
   */
  private schedule(): void {
    for (const watch of this.watches) {
      try {
        this.crons.push(
          this.makeCron(
            watch.cron,
            () => void this.tick(watch),
            watch.timezone ? { timezone: watch.timezone } : undefined,
          ),
        );
      } catch {
        // Invalid cron/timezone (e.g. hand-edited watches.json) → skip this watch.
      }
    }
  }

  private async tick(watch: Watch): Promise<void> {
    // Overlap guard: a watch whose Claude call outlasts its interval would
    // otherwise stack unbounded concurrent background runs (quota on a timer).
    if (this.inFlight.has(watch.id)) return;
    this.inFlight.add(watch.id);
    try {
      const text = await runWatch(watch, this.deps.respond);
      if (text) this.deps.notify({ text, speak: true, source: `watch:${watch.id}` });
    } catch {
      // A failed watch shouldn't crash the daemon; stay quiet.
    } finally {
      this.inFlight.delete(watch.id);
    }
  }

  stop(): void {
    this.running = false;
    for (const c of this.crons) c.stop();
    this.crons = [];
  }
}
