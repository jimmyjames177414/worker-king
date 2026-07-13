import Handlebars from 'handlebars';
import {
  characterCardV2Schema,
  type CharacterCardV2,
  type AssembledPersona,
} from '@workerking/shared';

/**
 * CharacterCard — load a SillyTavern-compatible chara_card_v2 and assemble it into
 * a runtime persona (the append string layered onto Claude Code's preset prompt,
 * plus a thinner voice persona, voice selection, and avatar pack).
 *
 * Templating uses Handlebars over {{char}} / {{user}} so cards from the existing
 * SillyTavern ecosystem drop in. This replaces the simple name+personality
 * assembly once a card is configured.
 */

export interface CardContext {
  /** The user's display name for {{user}} substitution. */
  userName?: string;
}

export function parseCharacterCard(json: unknown): CharacterCardV2 {
  return characterCardV2Schema.parse(json);
}

function render(template: string, vars: { char: string; user: string }): string {
  // Non-strict so missing helpers/vars render empty rather than throwing.
  return Handlebars.compile(template, { noEscape: true })(vars).trim();
}

const DEFAULT_VOICE = { provider: 'gpt-realtime' as const, voiceId: 'marin' };
const DEFAULT_AVATAR_PACK = 'default';

export function assemblePersonaFromCard(
  card: CharacterCardV2,
  ctx: CardContext = {},
): AssembledPersona {
  const d = card.data;
  const vars = { char: d.name, user: ctx.userName ?? 'the user' };

  const parts = [
    `You are ${d.name}, the user's personal desktop AI assistant.`,
    render(d.description, vars),
    d.personality ? `Personality: ${render(d.personality, vars)}` : '',
    d.scenario ? `Scenario: ${render(d.scenario, vars)}` : '',
    render(d.system_prompt, vars),
    'When speaking to the user, be concise and natural. Do the work, then report the outcome plainly.',
  ].filter((s) => s && s.length > 0);

  const append = parts.join('\n\n');

  // The thin voice persona stays short: name + personality only.
  const voicePersona = [
    `You are ${d.name}.`,
    d.personality ? render(d.personality, vars) : '',
    'Keep spoken replies short and natural.',
  ]
    .filter(Boolean)
    .join(' ');

  const wk = d.extensions?.workerking;
  return {
    systemPrompt: { type: 'preset', preset: 'claude_code', append },
    voiceSystemPrompt: voicePersona,
    voice: wk?.voice ?? DEFAULT_VOICE,
    avatarPack: wk?.avatar?.pack ?? DEFAULT_AVATAR_PACK,
  };
}
