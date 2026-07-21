/**
 * The "morning" standup trigger.
 *
 * Saying "morning" to a normal Claude Code session works because the protocol
 * lives in the user's global `~/.claude/CLAUDE.md`. WorkerKing's sessions never
 * see it: `ClaudeBackend` runs the SDK with `settingSources: []` on purpose, so
 * no user/project settings — including CLAUDE.md — are loaded (that isolation is
 * what stops a repo's `.claude/settings.json` auto-allowing tools past the N1
 * gate). Undoing it to pick up one section would be a bad trade.
 *
 * So WorkerKing carries the protocol itself. `isMorningTrigger` recognises the
 * phrase; the daemon runs the deterministic fetch; `morningProtocolBlock()` tells
 * Claude what to do next. The user's message still reaches Claude verbatim —
 * nothing is rewritten, the protocol rides in the system prompt.
 */

/** Trigger phrases, matching the Sprint install's own standup protocol. */
export const MORNING_TRIGGERS = [
  'morning',
  'standup',
  'stand up',
  'my tasks',
  "what's on my plate",
  'whats on my plate',
  'refresh daily context',
] as const;

/** Greeting filler that can precede the trigger without changing its meaning. */
const LEADING_FILLER = /^(?:ok(?:ay)?|so|hey|hi|hello|yo|good|g)\s+/;

/**
 * Normalize a spoken or typed message for trigger matching: lowercase, strip
 * surrounding punctuation, collapse whitespace, then peel greeting filler
 * ("good morning", "hey standup"). Voice transcripts arrive punctuated and
 * capitalized, so this has to be forgiving without becoming loose.
 */
function normalize(text: string): string {
  let s = text
    .toLowerCase()
    .replace(/[.,!?;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Peel repeatedly: "ok good morning" → "morning".
  let peeled = s.replace(LEADING_FILLER, '');
  while (peeled !== s) {
    s = peeled;
    peeled = s.replace(LEADING_FILLER, '');
  }
  return s;
}

/**
 * True when the whole message *is* the standup trigger.
 *
 * Deliberately whole-message: "morning" alone means "run the standup", but
 * "morning, can you also fix the build" is a normal request that happens to open
 * with a greeting. Hijacking the second one would be worse than missing it.
 */
export function isMorningTrigger(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  return (MORNING_TRIGGERS as readonly string[]).includes(normalized);
}

/** Outcome of the daemon-side fetch, folded into the protocol block. */
export type MorningFetchStatus = 'refreshed' | 'stale' | 'unreachable';

/**
 * The standup protocol, injected into Claude's system prompt so "morning" works
 * in ANY working directory rather than only where a CLAUDE.md defines it.
 *
 * Step 1 (the deterministic ADO fetch) is deliberately absent: the daemon has
 * already run it for this turn and awaited completion. Telling Claude to run it
 * again is exactly the race that would have two fetch.js processes writing
 * state.json at once — the Sprint server single-flights `/api/refresh`, but
 * `bin/fetch.js` invoked directly bypasses that guard.
 */
export function morningProtocolBlock(fetch?: {
  status: MorningFetchStatus;
  lastFetch?: string;
  lastFetchOk?: boolean;
}): string {
  const lines = [
    'Standup protocol — when the user says "morning", "standup", "my tasks", "what\'s on my plate",',
    'or "refresh daily context" (in ANY directory, not just the Sprint repo):',
    '  1. The deterministic ADO fetch has ALREADY been run for this turn by WorkerKing and it has',
    '     finished. Do NOT run bin/fetch.js, do NOT POST /api/refresh — a second fetch would race',
    '     the first for state.json.',
    '  2. Call get_standup_state and get_standup_diff, then narrate what changed: new / closed /',
    "     reassigned / changed / unknownGone, followed by the user's active tasks and focus order.",
    '  3. Keep it brief and spoken-friendly; lead with what needs their attention today.',
    '  4. Never write to `snapshot`, `sprint`, or `prs` — the fetcher owns those. Send no',
    '     notifications: the fetch already toasted.',
  ];
  if (fetch) {
    if (fetch.status === 'unreachable') {
      lines.push(
        '  Note: the last standup fetch could not reach the Sprint dashboard',
        '  (http://127.0.0.1:5757), so the data may be stale or missing. Say so rather than guessing.',
      );
    } else if (fetch.status === 'stale' || fetch.lastFetchOk === false) {
      lines.push(
        '  Note: the last standup fetch did not complete cleanly. Check `staleness` in',
        '  get_standup_state and tell the user the briefing may be out of date.',
      );
    } else if (fetch.lastFetch) {
      lines.push(`  Most recent standup fetch: ${fetch.lastFetch}.`);
    }
  }
  return lines.join('\n');
}
