import { describe, it, expect } from 'vitest';
import { computePersonaAppend } from '../main.js';
import { ConfigStore } from '../config/ConfigStore.js';

describe('computePersonaAppend (name + personality)', () => {
  it('uses the name and personality from config', () => {
    const config = new ConfigStore({ assistantName: 'Bea', personality: 'Terse and kind.' });
    const append = computePersonaAppend(config);
    expect(append).toContain('You are Bea');
    expect(append).toContain('Terse and kind.');
  });

  it('falls back to the default name when none is set', () => {
    const append = computePersonaAppend(new ConfigStore({ assistantName: '   ' }));
    expect(append).toContain('You are WorkerKing');
  });

  it('ignores a leftover characterCard key from an older config', () => {
    // Cards were removed; the config schema passes unknown keys through, so an
    // orphan one must be inert rather than resurrect the old branch.
    const config = new ConfigStore({
      assistantName: 'Bea',
      characterCard: { spec: 'chara_card_v2', data: { name: 'Jarvis' } },
    });
    const append = computePersonaAppend(config);
    expect(append).toContain('You are Bea');
    expect(append).not.toContain('Jarvis');
  });
});
