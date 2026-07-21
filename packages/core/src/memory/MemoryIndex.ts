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
  search(query: string, opts?: MemorySearchOptions): Promise<MemoryEntry[]>;
  /** All live entries, newest first (optionally filtered by scope). */
  list(opts?: MemorySearchOptions): Promise<MemoryEntry[]>;
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

  async search(query: string, opts: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
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

  async list(opts: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
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

/** Turns text into a dense vector. Implemented by a local embedding model. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Semantic retrieval: ranks live entries by cosine similarity between the query
 * embedding and each entry's embedding, so "what editor do they use" can match a
 * memory keyed "ide" that a keyword search would miss. Entry embeddings are
 * cached by key and invalidated when the entry's timestamp changes. `list()` is
 * identical to the keyword index (no embedding needed for a plain dump).
 */
export class SemanticMemoryIndex implements MemoryIndex {
  private readonly cache = new Map<string, { ts: number; vec: number[] }>();

  constructor(
    private readonly store: Pick<MemoryStore, 'all'>,
    private readonly embedder: Embedder,
  ) {}

  private live(scope?: MemoryScope): MemoryEntry[] {
    return this.store.all().filter((e) => !e.stale && (!scope || e.scope === scope));
  }

  private byRecency(entries: MemoryEntry[]): MemoryEntry[] {
    return [...entries].sort((a, b) => b.ts - a.ts);
  }

  private async embedEntry(entry: MemoryEntry): Promise<number[]> {
    const cached = this.cache.get(entry.key);
    if (cached && cached.ts === entry.ts) return cached.vec;
    const vec = await this.embedder.embed(`${entry.key}: ${entry.value}`);
    this.cache.set(entry.key, { ts: entry.ts, vec });
    return vec;
  }

  async search(query: string, opts: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    const live = this.live(opts.scope);
    if (!query.trim()) return this.byRecency(live).slice(0, opts.limit);

    const q = await this.embedder.embed(query);
    const scored = await Promise.all(
      live.map(async (entry) => ({ entry, score: cosine(q, await this.embedEntry(entry)) })),
    );
    const ranked = scored
      .sort((a, b) => b.score - a.score || b.entry.ts - a.entry.ts)
      .map((s) => s.entry);
    return opts.limit ? ranked.slice(0, opts.limit) : ranked;
  }

  async list(opts: MemorySearchOptions = {}): Promise<MemoryEntry[]> {
    const sorted = this.byRecency(this.live(opts.scope));
    return opts.limit ? sorted.slice(0, opts.limit) : sorted;
  }
}

export interface CreateMemoryIndexOptions {
  /** Opt into semantic retrieval (default keyword). */
  semantic?: boolean;
  /** Inject an embedder (tests / custom models); otherwise a local one is loaded. */
  embedder?: Embedder;
}

/** Which backend `createMemoryIndex` settled on, and why. */
export interface CreatedMemoryIndex {
  index: MemoryIndex;
  backend: 'semantic' | 'keyword';
  /** Only on the keyword backend: 'disabled' (setting off) or 'unavailable' (no model). */
  reason?: 'disabled' | 'unavailable';
}

/**
 * Pick the retrieval backend. Keyword by default. When `semantic` is on, load a
 * local embedding model (optional dependency, same dynamic-import pattern as the
 * local-voice engines) — and if the lib/model isn't installed, fall back to
 * keyword rather than failing. So enabling semantic memory without the model is a
 * graceful downgrade, and CI/default runs always use the keyword path.
 *
 * The outcome is REPORTED rather than swallowed: a silent downgrade is exactly
 * what makes the settings toggle dishonest, so the daemon passes this on to the
 * UI (runtime.features) to disable the control when no model is reachable.
 */
export async function createMemoryIndex(
  store: Pick<MemoryStore, 'all'>,
  opts: CreateMemoryIndexOptions = {},
): Promise<CreatedMemoryIndex> {
  if (!opts.semantic) {
    return { index: new KeywordMemoryIndex(store), backend: 'keyword', reason: 'disabled' };
  }
  try {
    const embedder = opts.embedder ?? (await loadLocalEmbedder());
    return { index: new SemanticMemoryIndex(store, embedder), backend: 'semantic' };
  } catch {
    // Model/lib unavailable → keyword fallback (never break recall).
    return { index: new KeywordMemoryIndex(store), backend: 'keyword', reason: 'unavailable' };
  }
}

/** Load a local sentence-embedding model via @huggingface/transformers (optional dep). */
async function loadLocalEmbedder(): Promise<Embedder> {
  // Variable specifier so the optional package stays off the build/typecheck graph.
  const pkg = '@huggingface/transformers';
  const mod = (await import(/* @vite-ignore */ pkg)) as {
    pipeline(
      task: string,
      model: string,
    ): Promise<(text: string, opts: unknown) => Promise<{ data: ArrayLike<number> }>>;
  };
  const pipe = await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return {
    embed: async (text: string) => {
      const out = await pipe(text, { pooling: 'mean', normalize: true });
      return Array.from(out.data);
    },
  };
}
