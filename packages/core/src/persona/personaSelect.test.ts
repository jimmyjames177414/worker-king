import { describe, it, expect } from 'vitest';
import { computePersonaAppend } from '../main.js';
import { ConfigStore } from '../config/ConfigStore.js';

describe('computePersonaAppend (card vs simple selection)', () => {
  it('uses the simple name+personality form when no card is set', () => {
    const config = new ConfigStore({ assistantName: 'Bea', personality: 'Terse and kind.' });
    const append = computePersonaAppend(config);
    expect(append).toContain('You are Bea');
    expect(append).toContain('Terse and kind.');
  });

  it('uses the character card when one is configured, with {{user}} substituted', () => {
    const config = new ConfigStore({
      userName: 'Sam',
      characterCard: {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
          name: 'Jarvis',
          description: '{{char}} assists {{user}}.',
          personality: 'Polished.',
          system_prompt: 'Be proactive.',
        },
      },
    });
    const append = computePersonaAppend(config);
    expect(append).toContain('You are Jarvis');
    expect(append).toContain('Jarvis assists Sam.');
    expect(append).toContain('Be proactive.');
  });

  it('falls back to the simple form when the card is malformed', () => {
    const config = new ConfigStore({
      assistantName: 'Fallback',
      characterCard: { spec: 'not-a-card' },
    });
    const append = computePersonaAppend(config);
    expect(append).toContain('You are Fallback');
  });
});
