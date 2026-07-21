import { describe, it, expect } from 'vitest';
import {
  computeVoiceContext,
  VOICE_BASE_PROMPT,
  MAX_VOICE_PROMPT_CHARS,
} from './VoiceContext.js';

const INPUT = {
  capabilitySummary: 'CAP: deploy, review',
  persona: 'PERSONA: you are Jarvis',
  orientation: 'ORIENT: assisting Sam; projects: a, b',
  sprint: 'SPRINT: 2 days left',
  memory: 'MEMORY: prefers dark mode',
  environment: 'ENV: full repo listing',
};

describe('computeVoiceContext', () => {
  it('always includes the behavioral base and capability summary', () => {
    for (const level of ['thin', 'standard', 'rich', 'maximal'] as const) {
      const out = computeVoiceContext(level, INPUT);
      expect(out).toContain(VOICE_BASE_PROMPT);
      expect(out).toContain('CAP:');
    }
  });

  it('thin = capability list only (no persona/orientation/sprint/memory/env)', () => {
    const out = computeVoiceContext('thin', INPUT);
    expect(out).not.toContain('PERSONA:');
    expect(out).not.toContain('ORIENT:');
    expect(out).not.toContain('SPRINT:');
    expect(out).not.toContain('MEMORY:');
    expect(out).not.toContain('ENV:');
  });

  it('standard adds persona + orientation but not sprint/memory/env', () => {
    const out = computeVoiceContext('standard', INPUT);
    expect(out).toContain('PERSONA:');
    expect(out).toContain('ORIENT:');
    expect(out).not.toContain('SPRINT:');
    expect(out).not.toContain('MEMORY:');
    expect(out).not.toContain('ENV:');
  });

  it('rich adds sprint + memory but not the full environment', () => {
    const out = computeVoiceContext('rich', INPUT);
    expect(out).toContain('SPRINT:');
    expect(out).toContain('MEMORY:');
    expect(out).not.toContain('ENV:');
  });

  it('maximal adds the full environment block', () => {
    const out = computeVoiceContext('maximal', INPUT);
    expect(out).toContain('ENV:');
  });

  it('never includes screen content (caller never passes it; sanity on inputs)', () => {
    const out = computeVoiceContext('maximal', INPUT);
    expect(out.toLowerCase()).not.toContain('screenshot');
  });

  it('drops empty/undefined blocks without leaving blank gaps', () => {
    const out = computeVoiceContext('rich', { capabilitySummary: 'CAP', persona: '', sprint: '  ' });
    expect(out).toBe(`${VOICE_BASE_PROMPT}\n\nCAP`);
  });

  it('caps the whole prompt at MAX_VOICE_PROMPT_CHARS', () => {
    const out = computeVoiceContext('maximal', {
      capabilitySummary: 'x'.repeat(10_000),
      environment: 'y'.repeat(10_000),
    });
    expect(out.length).toBeLessThanOrEqual(MAX_VOICE_PROMPT_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });
});
