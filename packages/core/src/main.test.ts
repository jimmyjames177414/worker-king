import { describe, it, expect } from 'vitest';
import { computePersonaAppend, createDaemonDeps, type DaemonDeps } from './main.js';
import { ConfigStore } from './config/ConfigStore.js';
import type { MemoryStore } from './memory/MemoryStore.js';

describe('createDaemonDeps', () => {
  it('returns injected stores as-is and never constructs the real ones', () => {
    // All five injected → no `new Store()` runs, so importing/using this module
    // in a test never touches ~/.claude (the point of the 2a refactor).
    const fakes = {
      memory: {} as MemoryStore,
      interactionLog: {} as DaemonDeps['interactionLog'],
      conversations: {} as DaemonDeps['conversations'],
      watchStore: {} as DaemonDeps['watchStore'],
      reminderStore: {} as DaemonDeps['reminderStore'],
    };
    const deps = createDaemonDeps(fakes);
    expect(deps.memory).toBe(fakes.memory);
    expect(deps.conversations).toBe(fakes.conversations);
    expect(deps.reminderStore).toBe(fakes.reminderStore);
  });
});

describe('computePersonaAppend memory injection', () => {
  const fakeMemory = { summary: () => 'Known facts: the user likes tea.' } as Pick<
    MemoryStore,
    'summary'
  >;

  it('appends the injected memory summary', () => {
    const append = computePersonaAppend(new ConfigStore(), { memory: fakeMemory });
    expect(append).toContain('likes tea');
  });

  it('omits memory entirely when none is injected (deterministic)', () => {
    const append = computePersonaAppend(new ConfigStore());
    expect(append).not.toContain('likes tea');
  });

  it('skips memory when memoryEnabled is false', () => {
    const append = computePersonaAppend(new ConfigStore({ memoryEnabled: false }), {
      memory: fakeMemory,
    });
    expect(append).not.toContain('likes tea');
  });

  it('still includes the persona base (name/personality)', () => {
    const append = computePersonaAppend(
      new ConfigStore({ assistantName: 'Bea', personality: 'calm and precise' }),
    );
    expect(append).toContain('Bea');
  });
});

describe('computePersonaAppend ambient context (F2)', () => {
  const fixedNow = () => new Date('2026-07-15T09:00:00.000Z');

  it('injects the current date/time', () => {
    const append = computePersonaAppend(new ConfigStore(), { now: fixedNow });
    expect(append).toContain('Current date and time: 2026-07-15T09:00:00.000Z');
  });

  it('injects the active project from cwd', () => {
    const append = computePersonaAppend(new ConfigStore(), {
      cwd: '/home/user/code/amethyst',
      now: fixedNow,
    });
    expect(append).toContain('Active project: amethyst (/home/user/code/amethyst)');
  });

  it('folds in the current conversation summary when present (closes N14)', () => {
    const convs = { currentSummary: () => 'user: earlier plan | assistant: earlier reply' };
    const append = computePersonaAppend(new ConfigStore(), { conversations: convs, now: fixedNow });
    expect(append).toContain('scrolled out of context');
    expect(append).toContain('earlier plan');
  });

  it('omits project/summary lines when there is no cwd or summary', () => {
    const append = computePersonaAppend(new ConfigStore(), {
      conversations: { currentSummary: () => undefined },
      now: fixedNow,
    });
    expect(append).not.toContain('Active project');
    expect(append).not.toContain('scrolled out of context');
  });
});
