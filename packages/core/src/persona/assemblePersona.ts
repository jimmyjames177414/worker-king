import type { WorkerKingConfig } from '../config/ConfigStore.js';

/**
 * Assemble the persona string appended to Claude Code's preset system prompt.
 *
 * Name + personality from config, and deliberately nothing more: this is the
 * whole persona pipeline. A SillyTavern character-card path existed here once
 * and was removed — it took the card *or* name+personality, never both, so
 * importing a card silently disabled the Personality setting with no way back.
 * The caller (computePersonaAppend) layers memories and ambient context on top.
 */
export function assemblePersonaAppend(
  config: Pick<WorkerKingConfig, 'assistantName' | 'personality'>,
): string {
  const name = config.assistantName?.trim() || 'WorkerKing';
  const personality = config.personality?.trim();
  const lines = [
    `You are ${name}, the user's personal desktop AI assistant.`,
    personality ? `Personality: ${personality}` : '',
    'When speaking to the user, be concise and natural. Do the work, then report the outcome plainly.',
  ].filter(Boolean);
  return lines.join('\n');
}
