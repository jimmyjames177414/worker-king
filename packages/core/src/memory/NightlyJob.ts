import { Cron } from 'croner';
import type { MemoryStore, MemoryEntry, MemoryScope } from './MemoryStore.js';
import type { InteractionLog } from './InteractionLog.js';

/**
 * NightlyJob — Letta-style "sleep-time" memory consolidation.
 *
 * On a schedule (idle hour), feeds the recent interaction log + current memories
 * to Claude and asks it to distill durable facts, dedup/update (not append), and
 * drop what's outdated — then writes the result back. Old live memories that the
 * distiller didn't carry forward are marked stale (kept for audit), never deleted.
 *
 * The `distill` function is injected so consolidation is unit-testable without a
 * real Claude call; `createClaudeDistiller` provides the real one.
 */

export interface DistilledMemory {
  key: string;
  value: string;
  scope: MemoryScope;
}

export interface DistillInput {
  memories: MemoryEntry[];
  interactions: string[];
}

export type Distiller = (input: DistillInput) => Promise<DistilledMemory[]>;

export interface ConsolidateDeps {
  memory: MemoryStore;
  log: InteractionLog;
  distill: Distiller;
  now?: () => number;
  maxInteractions?: number;
}

/** Run one consolidation pass. Safe to call on demand or from the schedule. */
export async function consolidate(deps: ConsolidateDeps): Promise<{ kept: number; staled: number }> {
  const now = deps.now ?? (() => Date.now());
  const liveBefore = deps.memory.recall();
  const interactions = deps.log.readRecent(deps.maxInteractions ?? 200).map((e) => `[${e.kind}] ${e.text}`);

  // Nothing to work from → no-op.
  if (!liveBefore.length && !interactions.length) return { kept: 0, staled: 0 };

  const distilled = await deps.distill({ memories: liveBefore, interactions });

  const distilledKeys = new Set(distilled.map((d) => d.key));
  const newLive: MemoryEntry[] = distilled.map((d) => ({
    key: d.key,
    value: d.value,
    scope: d.scope,
    ts: now(),
    provenance: 'nightly-consolidation',
  }));

  // Anything previously live but not carried forward → stale (audit), plus any
  // already-stale entries stay stale.
  const staled: MemoryEntry[] = deps.memory
    .all()
    .filter((e) => e.stale || !distilledKeys.has(e.key))
    .filter((e) => !distilledKeys.has(e.key))
    .map((e) => ({ ...e, stale: true }));

  deps.memory.replaceAll([...newLive, ...staled]);
  return { kept: newLive.length, staled: staled.length };
}

/**
 * The real distiller — asks Claude to return a JSON array of durable memories.
 * `respond` is the ClaudeBackend-style text responder (injected to avoid coupling
 * to the SDK here).
 */
export function createClaudeDistiller(
  respond: (prompt: string) => Promise<string>,
): Distiller {
  return async ({ memories, interactions }) => {
    const prompt = [
      'You are consolidating an assistant\'s long-term memory. Given the CURRENT MEMORIES and',
      'RECENT INTERACTIONS, output the durable set of facts/preferences worth keeping.',
      'Rules: merge duplicates, update outdated values (keep the newest), drop anything',
      'transient or no longer true, use short stable keys. Output ONLY a JSON array of',
      '{"key","value","scope"} where scope is "preference" | "fact" | "project". No prose.',
      '',
      'CURRENT MEMORIES:',
      JSON.stringify(memories.map((m) => ({ key: m.key, value: m.value, scope: m.scope }))),
      '',
      'RECENT INTERACTIONS:',
      interactions.slice(-100).join('\n'),
    ].join('\n');

    const text = await respond(prompt);
    return parseDistilled(text);
  };
}

/** Tolerantly extract the JSON array of memories from a model response. */
export function parseDistilled(text: string): DistilledMemory[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const arr = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x) => x && typeof x.key === 'string' && typeof x.value === 'string')
      .map((x) => ({
        key: x.key,
        value: x.value,
        scope: (['preference', 'fact', 'project'].includes(x.scope) ? x.scope : 'fact') as MemoryScope,
      }));
  } catch {
    return [];
  }
}

/** Schedules consolidation via croner (default: 3:30am daily). */
export class NightlyJob {
  private cron?: Cron;
  constructor(
    private readonly deps: ConsolidateDeps,
    private readonly cronExpr = '30 3 * * *',
  ) {}

  start(): void {
    this.cron = new Cron(this.cronExpr, () => {
      void consolidate(this.deps).catch(() => {});
    });
  }

  stop(): void {
    this.cron?.stop();
    this.cron = undefined;
  }
}
