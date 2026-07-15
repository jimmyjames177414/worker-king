import type { CapabilityManifestEntry } from './domain.js';

/**
 * Capability routing — score a free-text request against the capability manifest
 * so a voice/chat request can be matched to the right skill/command/agent/tool.
 *
 * Pure and dependency-free so both the daemon (server-side routing) and the
 * renderer (the command palette) share one ranking. Scoring is keyword overlap
 * between the request and each entry's name/description/routingHints, with name
 * matches weighted highest.
 */

export interface RankedCapability {
  entry: CapabilityManifestEntry;
  score: number;
}

const STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'with', 'my', 'me', 'i',
  'can', 'you', 'please', 'how', 'do', 'is', 'it', 'on', 'in', 'this', 'that',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Build routing keywords for an entry from its name and description. */
export function deriveRoutingHints(name: string, description: string): string[] {
  const hints = new Set<string>();
  for (const t of tokenize(name)) hints.add(t);
  for (const t of tokenize(description)) hints.add(t);
  return [...hints].slice(0, 16);
}

export function scoreCapability(queryTerms: string[], entry: CapabilityManifestEntry): number {
  const nameTokens = new Set(tokenize(entry.name));
  const hay = new Set<string>([
    ...nameTokens,
    ...tokenize(entry.description),
    ...(entry.routingHints ?? []).map((h) => h.toLowerCase()),
  ]);
  let score = 0;
  for (const q of queryTerms) {
    if (nameTokens.has(q)) score += 4; // matching the name is the strongest signal
    else if (hay.has(q)) score += 2; // exact hint/description token
    else if ([...hay].some((h) => h.includes(q) || q.includes(h))) score += 1; // partial
  }
  return score;
}

/** Rank capabilities by relevance to `query`; only positive scores are returned. */
export function routeRequest(
  query: string,
  entries: CapabilityManifestEntry[],
  opts: { limit?: number } = {},
): RankedCapability[] {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const ranked = entries
    .map((entry) => ({ entry, score: scoreCapability(terms, entry) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  return opts.limit ? ranked.slice(0, opts.limit) : ranked;
}
