import type { MemoryEntry, MemoryScope, MemoryStore } from './MemoryStore.js';

/**
 * MemoryIndex — the retrieval seam over MemoryStore.
 *
 * MemoryStore stays the portable, hand-editable source of truth; the index is a
 * derived read-only view that decides *how* memories are searched and ranked.
 * Today the only implementation is KeywordMemoryIndex (term-frequency ranking
 * over the file store). A future SemanticMemoryIndex (e.g. local transformers.js
 * embeddings kept in a sidecar file) can implement the same interface and drop in
 * without touching the store or the tools that consume it.
 */
export interface MemorySearchOptions {
  /** Restrict to a single scope. */
  scope?: MemoryScope;
  /** Cap the number of results. */
  limit?: number;
}

export interface MemoryIndex {
  /** Ranked matches for a free-text query (live entries only). */
  search(query: string, opts?: MemorySearchOptions): MemoryEntry[];
  /** All live entries, newest first (optionally filtered by scope). */
  list(opts?: MemorySearchOptions): MemoryEntry[];
}

/** Split a string into lowercase alphanumeric terms. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Keyword retrieval: scores each live entry by how many query terms occur in its
 * key/value, weighting key matches higher so a query that names a memory's key
 * ranks it first. No embeddings, no network — pure over the file store.
 */
export class KeywordMemoryIndex implements MemoryIndex {
  constructor(private readonly store: Pick<MemoryStore, 'all'>) {}

  private live(scope?: MemoryScope): MemoryEntry[] {
    return this.store.all().filter((e) => !e.stale && (!scope || e.scope === scope));
  }

  search(query: string, opts: MemorySearchOptions = {}): MemoryEntry[] {
    const terms = tokenize(query);
    const live = this.live(opts.scope);
    if (!terms.length) return this.sortByRecency(live).slice(0, opts.limit);

    const scored = live
      .map((entry) => ({ entry, score: this.score(entry, terms) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.ts - a.entry.ts)
      .map((s) => s.entry);

    return opts.limit ? scored.slice(0, opts.limit) : scored;
  }

  list(opts: MemorySearchOptions = {}): MemoryEntry[] {
    const sorted = this.sortByRecency(this.live(opts.scope));
    return opts.limit ? sorted.slice(0, opts.limit) : sorted;
  }

  private score(entry: MemoryEntry, terms: string[]): number {
    const keyTokens = tokenize(entry.key);
    const valueTokens = tokenize(entry.value);
    let score = 0;
    for (const term of terms) {
      // Key matches weigh 3x; value matches 1x. Term frequency accumulates.
      score += keyTokens.filter((t) => t.includes(term)).length * 3;
      score += valueTokens.filter((t) => t.includes(term)).length;
    }
    return score;
  }

  private sortByRecency(entries: MemoryEntry[]): MemoryEntry[] {
    return [...entries].sort((a, b) => b.ts - a.ts);
  }
}
