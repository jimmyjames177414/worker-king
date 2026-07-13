import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { parseCharacterCard, assemblePersonaFromCard } from './CharacterCard.js';

const here = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(here, '../../../../resources/characters/workerking-default.json');

const MINIMAL = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Jarvis',
    description: '{{char}} serves {{user}} faithfully.',
    personality: 'Polished and witty.',
    system_prompt: 'Be proactive.',
  },
};

describe('parseCharacterCard', () => {
  it('accepts a valid card and rejects a bad one', () => {
    expect(parseCharacterCard(MINIMAL).data.name).toBe('Jarvis');
    expect(() => parseCharacterCard({ spec: 'nope' })).toThrow();
  });
});

describe('assemblePersonaFromCard', () => {
  it('substitutes {{char}}/{{user}} and layers the preset prompt', () => {
    const persona = assemblePersonaFromCard(parseCharacterCard(MINIMAL), { userName: 'Sam' });
    expect(persona.systemPrompt.preset).toBe('claude_code');
    expect(persona.systemPrompt.append).toContain('You are Jarvis');
    expect(persona.systemPrompt.append).toContain('Jarvis serves Sam faithfully.');
    expect(persona.systemPrompt.append).toContain('Personality: Polished and witty.');
    expect(persona.systemPrompt.append).toContain('Be proactive.');
    // Thin voice persona stays short.
    expect(persona.voiceSystemPrompt).toContain('You are Jarvis.');
    expect(persona.voiceSystemPrompt.length).toBeLessThan(persona.systemPrompt.append.length);
  });

  it('defaults voice + avatar when the card omits workerking extensions', () => {
    const persona = assemblePersonaFromCard(parseCharacterCard(MINIMAL));
    expect(persona.voice).toEqual({ provider: 'gpt-realtime', voiceId: 'marin' });
    expect(persona.avatarPack).toBe('default');
  });

  it('reads voice + avatar from the bundled example card', () => {
    const card = parseCharacterCard(JSON.parse(readFileSync(EXAMPLE, 'utf8')));
    const persona = assemblePersonaFromCard(card, { userName: 'Alex' });
    expect(card.data.name).toBe('WorkerKing');
    expect(persona.voice.voiceId).toBe('marin');
    expect(persona.avatarPack).toBe('default');
    expect(persona.systemPrompt.append).toContain("Alex's tireless desktop right hand");
  });
});
