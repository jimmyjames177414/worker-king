import { describe, it, expect } from 'vitest';
import { isMorningTrigger, morningProtocolBlock, MORNING_TRIGGERS } from './morning.js';

describe('isMorningTrigger', () => {
  it('matches every documented trigger phrase', () => {
    for (const phrase of MORNING_TRIGGERS) expect(isMorningTrigger(phrase)).toBe(true);
  });

  it('tolerates how a voice transcript actually arrives', () => {
    expect(isMorningTrigger('Morning')).toBe(true);
    expect(isMorningTrigger('Good morning!')).toBe(true);
    expect(isMorningTrigger('  morning.  ')).toBe(true);
    expect(isMorningTrigger('Hey, standup')).toBe(true);
    expect(isMorningTrigger('ok good morning')).toBe(true);
    expect(isMorningTrigger("What's on my plate?")).toBe(true);
  });

  it('leaves a real request that merely opens with a greeting alone', () => {
    expect(isMorningTrigger('morning, can you fix the build')).toBe(false);
    expect(isMorningTrigger('good morning what did I miss in the amethyst repo')).toBe(false);
    expect(isMorningTrigger('add a standup section to the readme')).toBe(false);
    expect(isMorningTrigger('my tasks are failing in CI')).toBe(false);
  });

  it('ignores empty and filler-only input', () => {
    expect(isMorningTrigger('')).toBe(false);
    expect(isMorningTrigger('   ')).toBe(false);
    expect(isMorningTrigger('hey')).toBe(false);
    expect(isMorningTrigger('good')).toBe(false);
  });
});

describe('morningProtocolBlock', () => {
  it('tells Claude the fetch already ran, so it cannot race a second one', () => {
    const block = morningProtocolBlock();
    expect(block).toMatch(/ALREADY been run/);
    expect(block).toMatch(/Do NOT run bin\/fetch\.js/);
    expect(block).toMatch(/get_standup_diff/);
  });

  it('flags an unreachable dashboard instead of letting Claude narrate stale data', () => {
    expect(morningProtocolBlock({ status: 'unreachable' })).toMatch(/could not reach/);
  });

  it('flags a fetch that did not complete cleanly', () => {
    expect(morningProtocolBlock({ status: 'stale' })).toMatch(/did not complete cleanly/);
    expect(morningProtocolBlock({ status: 'refreshed', lastFetchOk: false })).toMatch(
      /did not complete cleanly/,
    );
  });

  it('reports the completion time on a clean fetch', () => {
    const block = morningProtocolBlock({
      status: 'refreshed',
      lastFetch: '2026-07-21T10:57:14.373Z',
      lastFetchOk: true,
    });
    expect(block).toContain('2026-07-21T10:57:14.373Z');
  });
});
