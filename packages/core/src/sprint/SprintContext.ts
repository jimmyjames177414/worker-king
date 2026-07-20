/**
 * SprintContext — injects a compact sprint summary into Claude's system prompt
 * on every turn so Claude is always sprint-aware without a tool call.
 *
 * Fetches from the local Sprint dashboard (http://127.0.0.1:5757/api/state).
 * Fails silently when Sprint is not running — the block is simply omitted.
 * The block is cached for 10 minutes; a background refresh runs when stale.
 */

export class SprintContext {
  private cached: string | null = null;
  private fetchedAt = 0;
  private readonly ttlMs: number;

  constructor({ ttlMs = 10 * 60 * 1000 }: { ttlMs?: number } = {}) {
    this.ttlMs = ttlMs;
  }

  /** Synchronous — returns cached block or triggers a background refresh. */
  sprintBlock(): string {
    const age = Date.now() - this.fetchedAt;
    if (this.cached !== null && age < this.ttlMs) return this.cached;
    this.refresh().catch(() => {});
    return this.cached ?? '';
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch('http://127.0.0.1:5757/api/state', {
        signal: AbortSignal.timeout(4_000),
      });
      if (!res.ok) {
        this.cached = null;
        this.fetchedAt = Date.now(); // apply TTL on failure to avoid retry spam
        return;
      }
      const state = (await res.json()) as SprintApiState;
      this.cached = this.buildBlock(state);
      this.fetchedAt = Date.now();
    } catch {
      // Sprint not running — omit the block rather than injecting stale data.
      this.cached = null;
      this.fetchedAt = Date.now(); // apply TTL on failure to avoid retry spam
    }
  }

  private buildBlock(state: SprintApiState): string {
    const lines: string[] = ['Sprint standup context (from local dashboard, http://127.0.0.1:5757):'];

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

    if (state.lastFetch) {
      const ageMin = Math.round((Date.now() - new Date(state.lastFetch).getTime()) / 60_000);
      const ageStr = ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
      lines.push(
        `  Last ADO fetch: ${ageStr}${state.lastFetchOk === false ? ' (last fetch FAILED)' : ''}`,
      );
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
}
