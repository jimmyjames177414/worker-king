import { describe, it, expect } from 'vitest';
import { parsePaletteQuery, insertionFor, paletteMatches } from './palette.js';
import type { CapabilityManifestEntry } from '@workerking/shared';

function entry(kind: CapabilityManifestEntry['kind'], name: string, description = ''): CapabilityManifestEntry {
  return { kind, name, description, source: 'user' };
}

describe('parsePaletteQuery', () => {
  it('returns the query after a leading slash', () => {
    expect(parsePaletteQuery('/dep')).toBe('dep');
    expect(parsePaletteQuery('/')).toBe('');
  });
  it('returns null when not in palette mode', () => {
    expect(parsePaletteQuery('hello')).toBeNull();
    expect(parsePaletteQuery('a /b')).toBeNull();
  });
});

describe('insertionFor', () => {
  it('formats commands as a slash invocation', () => {
    expect(insertionFor(entry('command', 'deploy'))).toBe('/deploy ');
  });
  it('formats other capabilities as a natural instruction', () => {
    expect(insertionFor(entry('agent', 'reviewer'))).toBe('Use reviewer: ');
    expect(insertionFor(entry('skill', 'summarize'))).toBe('Use summarize: ');
  });
});

describe('paletteMatches', () => {
  const entries = [
    entry('command', 'deploy', 'ship the app'),
    entry('agent', 'reviewer', 'reviews code'),
    entry('skill', 'summarize', 'summarize text'),
  ];

  it('lists entries alphabetically when the query is empty', () => {
    expect(paletteMatches('', entries).map((e) => e.name)).toEqual(['deploy', 'reviewer', 'summarize']);
  });

  it('ranks by relevance for a non-empty query', () => {
    expect(paletteMatches('review', entries)[0].name).toBe('reviewer');
  });

  it('honors the limit', () => {
    expect(paletteMatches('', entries, 1)).toHaveLength(1);
  });
});
