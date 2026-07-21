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
 *
 * The name is a parameter, not a constant: at `thin` level this is the ONLY name
 * the voice model ever sees, and at `standard`+ a hardcoded one would contradict
 * the persona block that follows it.
 */
export function voiceBasePrompt(assistantName?: string): string {
  const name = assistantName?.trim() || 'WorkerKing';
  return [
    `You are ${name}, a helpful desktop voice assistant. Keep spoken replies concise and natural.`,
    'You are a thin voice layer over a capable worker (Claude Code). Handle greetings and small talk',
    'yourself, but for ANYTHING substantive — running commands, editing files, answering questions that',
    'need tools — first say a short filler like "On it" or "Let me take care of that", then call',
    'delegate_to_worker with the task. Progress and results will be spoken to the user automatically as',
    "they arrive; read them out naturally. Use check_task_status ONLY when the user asks how it's going —",
    'never poll it on your own or narrate repeated status checks. While a task runs, stay quiet unless',
    'the user speaks or an update arrives. Use cancel_task if they want to stop.',
    // The standup triggers look like greetings but are commands; without this
    // carve-out "morning" is answered with "Good morning!" and never reaches the
    // worker. The worker recognises the exact phrase, so pass it through unchanged
    // rather than paraphrasing it into a task description.
    'EXCEPTION — these are NOT small talk: "morning", "standup", "my tasks", "what\'s on my plate",',
    '"refresh daily context". They mean "run my daily standup briefing". Say a short filler, then call',
    'delegate_to_worker with the task set to the user\'s exact words and nothing else (task: "morning").',
    'Do not add context, do not rephrase, and do not answer the greeting yourself.',
  ].join(' ');
}

/** The base prompt under the default name — what callers assert against. */
export const VOICE_BASE_PROMPT = voiceBasePrompt();

/** Pre-rendered blocks the daemon supplies; this module decides which to use. */
export interface VoiceContextInput {
  /** What the assistant calls itself (config `assistantName`) — used in the base. */
  assistantName?: string;
  /** Rendered capability summary (renderVoiceSummary) — included at every level. */
  capabilitySummary?: string;
  /** Short voice persona (name + personality) — standard+. */
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
  const parts = [
    voiceBasePrompt(input.assistantName),
    input.capabilitySummary,
    ...blocksForLevel(level, input),
  ]
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p));
  const prompt = parts.join('\n\n');
  return prompt.length > MAX_VOICE_PROMPT_CHARS
    ? `${prompt.slice(0, MAX_VOICE_PROMPT_CHARS - 1)}…`
    : prompt;
}
