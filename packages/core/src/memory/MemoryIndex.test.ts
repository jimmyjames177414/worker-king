import { describe, it, expect } from 'vitest';
import { KeywordMemoryIndex } from './MemoryIndex.js';
import type { MemoryEntry } from './MemoryStore.js';

function entry(key: string, value: string, scope: MemoryEntry['scope'], ts: number, stale = false): MemoryEntry {
  return { key, value, scope, ts, provenance: 'test', stale };
}

function fakeStore(entries: MemoryEntry[]): { all: () => MemoryEntry[] } {
  return { all: () => entries };
}

describe('KeywordMemoryIndex', () => {
  it('ranks key matches above value matches', () => {
    const index = new KeywordMemoryIndex(
      fakeStore([
        entry('editor', 'Cursor', 'preference', 1),
        entry('notes', 'they love their editor being fast', 'fact', 2),
      ]),
    );
    const hits = index.search('editor');
    expect(hits.map((e) => e.key)).toEqual(['editor', 'notes']);
  });

  it('excludes stale entries', () => {
    const index = new KeywordMemoryIndex(
      fakeStore([entry('editor', 'Cursor', 'preference', 1, true)]),
    );
    expect(index.search('editor')).toHaveLength(0);
    expect(index.list()).toHaveLength(0);
  });

  it('filters by scope and honors limit', () => {
    const index = new KeywordMemoryIndex(
      fakeStore([
        entry('a', 'match one', 'fact', 1),
        entry('b', 'match two', 'project', 2),
        entry('c', 'match three', 'fact', 3),
      ]),
    );
    expect(index.search('match', { scope: 'fact' }).map((e) => e.key).sort()).toEqual(['a', 'c']);
    expect(index.search('match', { limit: 1 })).toHaveLength(1);
  });

  it('returns no hits when nothing matches', () => {
    const index = new KeywordMemoryIndex(fakeStore([entry('editor', 'Cursor', 'preference', 1)]));
    expect(index.search('database')).toHaveLength(0);
  });

  it('list() returns live entries newest first', () => {
    const index = new KeywordMemoryIndex(
      fakeStore([
        entry('old', 'x', 'fact', 1),
        entry('new', 'y', 'fact', 3),
        entry('mid', 'z', 'fact', 2),
      ]),
    );
    expect(index.list().map((e) => e.key)).toEqual(['new', 'mid', 'old']);
  });

  it('empty query lists everything by recency', () => {
    const index = new KeywordMemoryIndex(
      fakeStore([entry('a', 'x', 'fact', 1), entry('b', 'y', 'fact', 2)]),
    );
    expect(index.search('').map((e) => e.key)).toEqual(['b', 'a']);
  });
});
