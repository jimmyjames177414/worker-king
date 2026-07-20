import { describe, it, expect } from 'vitest';
import {
  KeywordMemoryIndex,
  SemanticMemoryIndex,
  createMemoryIndex,
  type Embedder,
} from './MemoryIndex.js';
import type { MemoryEntry } from './MemoryStore.js';

function entry(
  key: string,
  value: string,
  scope: MemoryEntry['scope'],
  ts: number,
  stale = false,
): MemoryEntry {
  return { key, value, scope, ts, provenance: 'test', stale };
}

function fakeStore(entries: MemoryEntry[]): { all: () => MemoryEntry[] } {
  return { all: () => entries };
}

describe('KeywordMemoryIndex', () => {
  it('ranks key matches above value matches', async () => {
    const index = new KeywordMemoryIndex(
      fakeStore([
        entry('editor', 'Cursor', 'preference', 1),
        entry('notes', 'they love their editor being fast', 'fact', 2),
      ]),
    );
    const hits = await index.search('editor');
    expect(hits.map((e) => e.key)).toEqual(['editor', 'notes']);
  });

  it('excludes stale entries', async () => {
    const index = new KeywordMemoryIndex(
      fakeStore([entry('editor', 'Cursor', 'preference', 1, true)]),
    );
    expect(await index.search('editor')).toHaveLength(0);
    expect(await index.list()).toHaveLength(0);
  });

  it('filters by scope and honors limit', async () => {
    const index = new KeywordMemoryIndex(
      fakeStore([
        entry('a', 'match one', 'fact', 1),
        entry('b', 'match two', 'project', 2),
        entry('c', 'match three', 'fact', 3),
      ]),
    );
    expect((await index.search('match', { scope: 'fact' })).map((e) => e.key).sort()).toEqual([
      'a',
      'c',
    ]);
    expect(await index.search('match', { limit: 1 })).toHaveLength(1);
  });

  it('returns no hits when nothing matches', async () => {
    const index = new KeywordMemoryIndex(fakeStore([entry('editor', 'Cursor', 'preference', 1)]));
    expect(await index.search('database')).toHaveLength(0);
  });

  it('list() returns live entries newest first', async () => {
    const index = new KeywordMemoryIndex(
      fakeStore([
        entry('old', 'x', 'fact', 1),
        entry('new', 'y', 'fact', 3),
        entry('mid', 'z', 'fact', 2),
      ]),
    );
    expect((await index.list()).map((e) => e.key)).toEqual(['new', 'mid', 'old']);
  });

  it('empty query lists everything by recency', async () => {
    const index = new KeywordMemoryIndex(
      fakeStore([entry('a', 'x', 'fact', 1), entry('b', 'y', 'fact', 2)]),
    );
    expect((await index.search('')).map((e) => e.key)).toEqual(['b', 'a']);
  });
});

/** Fake embedder: 1-hot-ish vectors keyed by which topic words appear. */
function fakeEmbedder(): Embedder & { calls: number } {
  const axes = ['editor', 'coffee', 'timezone'];
  const vec = (text: string) => axes.map((a) => (text.toLowerCase().includes(a) ? 1 : 0));
  return {
    calls: 0,
    async embed(text: string) {
      this.calls++;
      const v = vec(text);
      // Ensure a non-zero vector so cosine is defined.
      return v.some((x) => x) ? v : [0.01, 0.01, 0.01];
    },
  };
}

describe('SemanticMemoryIndex', () => {
  it('ranks by embedding similarity, not keyword overlap', async () => {
    const store = fakeStore([
      entry('ide', 'they use the editor called Cursor', 'preference', 2),
      entry('drink', 'coffee, oat latte', 'preference', 1),
    ]);
    const index = new SemanticMemoryIndex(store, fakeEmbedder());
    // Query shares no keyword with the "ide" key, but is semantically about editor.
    const hits = await index.search('editor');
    expect(hits[0].key).toBe('ide');
  });

  it('caches entry embeddings until the timestamp changes', async () => {
    const emb = fakeEmbedder();
    const store = fakeStore([entry('ide', 'editor', 'preference', 1)]);
    const index = new SemanticMemoryIndex(store, emb);
    await index.search('editor');
    const afterFirst = emb.calls;
    await index.search('editor'); // query + entry; entry is cached
    expect(emb.calls).toBe(afterFirst + 1); // only the query re-embedded
  });
});

describe('createMemoryIndex', () => {
  it('returns the keyword index by default', async () => {
    const index = await createMemoryIndex(fakeStore([entry('editor', 'Cursor', 'preference', 1)]));
    expect(index).toBeInstanceOf(KeywordMemoryIndex);
  });

  it('uses the injected embedder when semantic is on', async () => {
    const index = await createMemoryIndex(fakeStore([]), {
      semantic: true,
      embedder: fakeEmbedder(),
    });
    expect(index).toBeInstanceOf(SemanticMemoryIndex);
  });

  it('falls back to keyword when semantic is on but no model is available', async () => {
    // No embedder injected and the optional package isn't installed → keyword.
    const index = await createMemoryIndex(fakeStore([]), { semantic: true });
    expect(index).toBeInstanceOf(KeywordMemoryIndex);
  });
});
