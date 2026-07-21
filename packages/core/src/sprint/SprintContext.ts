import type { MorningFetchStatus } from './morning.js';

/**
 * SprintContext — injects a compact sprint summary into Claude's system prompt
 * on every turn so Claude is always sprint-aware without a tool call, and owns
 * the deterministic standup fetch behind the "morning" trigger.
 *
 * Fetches from the local Sprint dashboard (http://127.0.0.1:5757/api/state).
 * Fails silently when Sprint is not running — the block is simply omitted.
 * The block is cached for 10 minutes; a background refresh runs when stale.
 *
 * Every network path is single-flight. Two "morning"s in quick succession, or a
 * background staleness refresh overlapping a forced one, must never produce two
 * concurrent ADO fetches writing state.json.
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:5757';

/** What the daemon-side standup fetch achieved, handed to the protocol block. */
export interface MorningFetchResult {
  status: MorningFetchStatus;
  /** `staleness.lastFetch` after the run, when readable. */
  lastFetch?: string;
  lastFetchOk?: boolean;
}

export interface SprintContextOptions {
  ttlMs?: number;
  baseUrl?: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** How often to check whether the spawned fetch has landed. */
  pollMs?: number;
  /** How long to wait for it before giving up and narrating what we have. */
  fetchTimeoutMs?: number;
  /** Injected for tests so the poll loop doesn't burn real seconds. */
  sleep?: (ms: number) => Promise<void>;
}

export class SprintContext {
  private cached: string | null = null;
  private fetchedAt = 0;
  private readonly ttlMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly pollMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** In-flight block refresh, shared by every concurrent caller. */
  private inflight?: Promise<void>;
  /** In-flight standup fetch, so a second "morning" joins rather than re-runs. */
  private inflightMorning?: Promise<MorningFetchResult>;
  /** Outcome of the last standup fetch, folded into the injected protocol block. */
  private lastMorning?: MorningFetchResult;

  constructor(opts: SprintContextOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.pollMs = opts.pollMs ?? 1_000;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? 90_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Synchronous — returns cached block or triggers a background refresh. */
  sprintBlock(): string {
    const age = Date.now() - this.fetchedAt;
    // Respect the TTL by recency, not by whether we have a block: a *failed*
    // fetch also sets fetchedAt, and re-fetching on every call until it succeeds
    // is exactly the retry spam the TTL exists to prevent. `fetchedAt === 0`
    // (never fetched) makes `age` huge, so the first call always refreshes.
    if (age < this.ttlMs) return this.cached ?? '';
    this.refresh().catch(() => {});
    return this.cached ?? '';
  }

  /** Rebuild the cached block. Joins an in-flight refresh instead of racing it. */
  refresh(): Promise<void> {
    return this.inflight ?? this.startRefresh();
  }

  private startRefresh(): Promise<void> {
    // Assigned synchronously, before the first await inside doRefresh, so a
    // concurrent caller reaching `refresh()` always sees the in-flight promise.
    const run = this.doRefresh().finally(() => {
      this.inflight = undefined;
    });
    this.inflight = run;
    return run;
  }

  /**
   * Rebuild from data fetched *now*, never from a refresh that started earlier.
   * The standup fetch needs this: a background refresh that began before the ADO
   * fetch landed would cache pre-fetch state and we'd narrate yesterday.
   */
  private async refreshNow(): Promise<void> {
    if (this.inflight) await this.inflight.catch(() => {});
    return this.startRefresh();
  }

  private async doRefresh(): Promise<void> {
    const state = await this.readState();
    if (!state) {
      // Sprint not running / unreadable — omit the block rather than inject stale data.
      this.cached = null;
      this.fetchedAt = Date.now(); // apply TTL on failure to avoid retry spam
      return;
    }
    this.cached = this.buildBlock(state);
    this.fetchedAt = Date.now();
  }

  /** GET /api/state, or undefined when Sprint is unreachable or errored. */
  private async readState(): Promise<SprintApiState | undefined> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/state`, {
        signal: AbortSignal.timeout(4_000),
      });
      if (!res.ok) return undefined;
      return (await res.json()) as SprintApiState;
    } catch {
      return undefined;
    }
  }

  /**
   * Step 1 of the standup protocol: run the deterministic ADO fetch and wait for
   * it to land, so the briefing Claude narrates is current.
   *
   * `POST /api/refresh` is fire-and-forget (202) and single-flights server-side
   * (409 when a fetch or a notes run is already going), so completion is detected
   * by polling `staleness.lastFetch` for a change rather than by the response.
   * A 409 is therefore not an error — someone else's fetch will bump the same
   * field, and waiting for it is exactly right.
   */
  runMorningFetch(): Promise<MorningFetchResult> {
    if (this.inflightMorning) return this.inflightMorning;
    const run = this.doMorningFetch()
      .then((result) => {
        this.lastMorning = result;
        return result;
      })
      .finally(() => {
        this.inflightMorning = undefined;
      });
    this.inflightMorning = run;
    return run;
  }

  /** The last standup fetch's outcome, or undefined if none has run this session. */
  lastMorningFetch(): MorningFetchResult | undefined {
    return this.lastMorning;
  }

  private async doMorningFetch(): Promise<MorningFetchResult> {
    const before = await this.readState();
    if (!before) return { status: 'unreachable' };
    const previousFetch = before.staleness?.lastFetch ?? before.lastFetch ?? undefined;

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/refresh`, {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
      });
      // 409 = a fetch (or notes run) is already in flight; wait for that one.
      if (!res.ok && res.status !== 409) return { status: 'stale', ...this.stamp(before) };
    } catch {
      return { status: 'unreachable' };
    }

    const landed = await this.waitForFetch(previousFetch);
    // Rebuild from data fetched after the wait, not from an older in-flight refresh.
    await this.refreshNow();
    if (!landed) return { status: 'stale', ...this.stamp(before) };
    return { status: 'refreshed', ...this.stamp(landed) };
  }

  /** Poll until `lastFetch` moves off `previous`, or the budget runs out. */
  private async waitForFetch(previous?: string): Promise<SprintApiState | undefined> {
    const deadline = Date.now() + this.fetchTimeoutMs;
    while (Date.now() < deadline) {
      await this.sleep(this.pollMs);
      const state = await this.readState();
      if (!state) continue; // the server restarts mid-fetch sometimes; keep waiting
      const current = state.staleness?.lastFetch ?? state.lastFetch;
      if (current && current !== previous) return state;
    }
    return undefined;
  }

  private stamp(state: SprintApiState): Pick<MorningFetchResult, 'lastFetch' | 'lastFetchOk'> {
    const lastFetch = state.staleness?.lastFetch ?? state.lastFetch;
    const lastFetchOk = state.staleness?.lastFetchOk ?? state.lastFetchOk;
    return {
      ...(lastFetch ? { lastFetch } : {}),
      ...(lastFetchOk !== undefined ? { lastFetchOk } : {}),
    };
  }

  private buildBlock(state: SprintApiState): string {
    const lines: string[] = [
      'Sprint standup context (from local dashboard, http://127.0.0.1:5757):',
    ];

    if (state.sprint?.name) {
      const finish = state.sprint.finishDate ? new Date(state.sprint.finishDate) : null;
      const daysLeft = finish ? Math.ceil((finish.getTime() - Date.now()) / 86_400_000) : null;
      const dayStr =
        daysLeft !== null
          ? ` (${daysLeft > 0 ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : 'ends today'})`
          : '';
      lines.push(`  Sprint: ${state.sprint.name}${dayStr}`);
    }

    const focus = state.focus ?? [];
    if (focus.length) {
      lines.push(`  Focus items: ${focus.length}`);
      for (const f of focus.slice(0, 3)) {
        lines.push(`    - ${f.label ?? f.ref ?? '?'}`);
      }
      if (focus.length > 3) lines.push(`    … and ${focus.length - 3} more`);
    }

    const created = state.prs?.created ?? [];
    const reviewing = state.prs?.reviewing ?? [];
    if (created.length || reviewing.length) {
      lines.push(
        `  PRs: ${created.length} open by you` +
          (reviewing.length ? `, ${reviewing.length} awaiting your review` : ''),
      );
    }

    const lastFetch = state.staleness?.lastFetch ?? state.lastFetch;
    if (lastFetch) {
      const ageMin = Math.round((Date.now() - new Date(lastFetch).getTime()) / 60_000);
      const ageStr = ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
      const failed = (state.staleness?.lastFetchOk ?? state.lastFetchOk) === false;
      lines.push(`  Last ADO fetch: ${ageStr}${failed ? ' (last fetch FAILED)' : ''}`);
    }

    return lines.join('\n');
  }
}

interface SprintApiState {
  sprint?: { name?: string; finishDate?: string };
  focus?: Array<{ ref?: string; label?: string }>;
  prs?: { created?: unknown[]; reviewing?: unknown[] };
  lastFetch?: string;
  lastFetchOk?: boolean;
  /** Server-computed staleness wrapper (buildStateResponse). */
  staleness?: { lastFetch?: string | null; lastFetchOk?: boolean };
}
