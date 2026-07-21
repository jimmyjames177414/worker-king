/**
 * VoiceContext — assembles the full system prompt for the thin voice model.
 *
 * Single source of truth for what the OpenAI Realtime layer knows: the
 * behavioral base (its "delegate substantive work" role), the capability
 * summary, and a configurable LEVEL of ambient context reusing the same
 * producers the Claude brain uses. Screen content is never included.
 *
 * The daemon computes the pieces (persona, orientation, sprint, memory,
 * environment) and passes them in; this module owns the base string and the
 * level → which-blocks gating, so the policy is unit-testable in one place.
 */

export type VoiceContextLevel = 'thin' | 'standard' | 'rich' | 'maximal';

/** Overall cap on the voice prompt — keeps latency/cost bounded at every level. */
export const MAX_VOICE_PROMPT_CHARS = 6000;

/**
 * The behavioral base (moved here from the overlay's hardcoded string). This is
 * ROLE, not context — it's included at every level.
 */
export const VOICE_BASE_PROMPT = [
  'You are WorkerKing, a helpful desktop voice assistant. Keep spoken replies concise and natural.',
  'You are a thin voice layer over a capable worker (Claude Code). Handle greetings and small talk',
  'yourself, but for ANYTHING substantive — running commands, editing files, answering questions that',
  'need tools — first say a short filler like "On it" or "Let me take care of that", then call',
  'delegate_to_worker with the task. Progress and results will be spoken to the user automatically as',
  "they arrive; read them out naturally. Use check_task_status ONLY when the user asks how it's going —",
  'never poll it on your own or narrate repeated status checks. While a task runs, stay quiet unless',
  'the user speaks or an update arrives. Use cancel_task if they want to stop.',
].join(' ');

/** Pre-rendered blocks the daemon supplies; this module decides which to use. */
export interface VoiceContextInput {
  /** Rendered capability summary (renderVoiceSummary) — included at every level. */
  capabilitySummary?: string;
  /** Short voice persona (card voiceSystemPrompt or name+personality) — standard+. */
  persona?: string;
  /** Compact orientation (user name, time, active project, repo names) — standard+. */
  orientation?: string;
  /** Sprint standup block — rich+. */
  sprint?: string;
  /** Remembered-facts summary, ALREADY fenced by the caller — rich+. */
  memory?: string;
  /** Full environment block (OS, roots, rules, notes) — maximal only. */
  environment?: string;
}

/** Which blocks each level admits (base + capability list are always on). */
function blocksForLevel(level: VoiceContextLevel, i: VoiceContextInput): Array<string | undefined> {
  switch (level) {
    case 'thin':
      return [];
    case 'standard':
      return [i.persona, i.orientation];
    case 'rich':
      return [i.persona, i.orientation, i.sprint, i.memory];
    case 'maximal':
      return [i.persona, i.orientation, i.sprint, i.memory, i.environment];
  }
}

/**
 * Assemble the voice system prompt for a given level. Always includes the
 * behavioral base and (if present) the capability summary; layers the
 * level-gated ambient blocks; caps the whole thing to MAX_VOICE_PROMPT_CHARS.
 */
export function computeVoiceContext(level: VoiceContextLevel, input: VoiceContextInput): string {
  const parts = [VOICE_BASE_PROMPT, input.capabilitySummary, ...blocksForLevel(level, input)]
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p));
  const prompt = parts.join('\n\n');
  return prompt.length > MAX_VOICE_PROMPT_CHARS
    ? `${prompt.slice(0, MAX_VOICE_PROMPT_CHARS - 1)}…`
    : prompt;
}
