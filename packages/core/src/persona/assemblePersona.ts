import type { WorkerKingConfig } from '../config/ConfigStore.js';

/**
 * Assemble the persona string appended to Claude Code's preset system prompt.
 *
 * Phase 1 keeps this simple (name + personality from config). Phase 4 replaces
 * it with full SillyTavern character-card assembly (Handlebars over
 * {{char}}/{{user}}), producing the same `append` string — so ClaudeBackend and
 * the Supervisor don't change when cards arrive.
 */
export function assemblePersonaAppend(config: Pick<WorkerKingConfig, 'assistantName' | 'personality'>): string {
  const name = config.assistantName?.trim() || 'WorkerKing';
  const personality = config.personality?.trim();
  const lines = [
    `You are ${name}, the user's personal desktop AI assistant.`,
    personality ? `Personality: ${personality}` : '',
    'When speaking to the user, be concise and natural. Do the work, then report the outcome plainly.',
  ].filter(Boolean);
  return lines.join('\n');
}
