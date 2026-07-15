import { describe, it, expect } from 'vitest';
import { routeRequest, deriveRoutingHints, tokenize, type RankedCapability } from './routing.js';
import type { CapabilityManifestEntry } from './domain.js';

function entry(
  name: string,
  description: string,
  routingHints?: string[],
): CapabilityManifestEntry {
  return { kind: 'skill', name, description, source: 'user', routingHints };
}

describe('tokenize', () => {
  it('lowercases, splits, and drops stopwords/short tokens', () => {
    expect(tokenize('Deploy the App to Production')).toEqual(['deploy', 'app', 'production']);
  });
});

describe('deriveRoutingHints', () => {
  it('collects keywords from name and description', () => {
    const hints = deriveRoutingHints('deploy', 'ship the app to production');
    expect(hints).toContain('deploy');
    expect(hints).toContain('production');
  });
});

describe('routeRequest', () => {
  const entries = [
    entry('deploy', 'ship the app to production'),
    entry('screenshot', 'capture the screen', ['image', 'picture']),
    entry('rename-files', 'batch rename files in a folder'),
  ];

  it('ranks the best-matching capability first', () => {
    const ranked = routeRequest('deploy my app', entries);
    expect(ranked[0].entry.name).toBe('deploy');
  });

  it('matches via routing hints, not just name', () => {
    const ranked = routeRequest('take a picture of the screen', entries);
    expect(ranked[0].entry.name).toBe('screenshot');
  });

  it('weights name matches above description matches', () => {
    const ranked: RankedCapability[] = routeRequest('rename', entries);
    expect(ranked[0].entry.name).toBe('rename-files');
  });

  it('returns nothing for an unrelated query', () => {
    expect(routeRequest('order a pizza', entries)).toEqual([]);
  });

  it('honors the limit', () => {
    const ranked = routeRequest('app files screen', entries, { limit: 1 });
    expect(ranked).toHaveLength(1);
  });
});
