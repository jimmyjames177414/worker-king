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
    const append = computePersonaAppend(new ConfigStore(), fakeMemory);
    expect(append).toContain('likes tea');
  });

  it('omits memory entirely when none is injected (deterministic)', () => {
    const append = computePersonaAppend(new ConfigStore());
    expect(append).not.toContain('likes tea');
  });

  it('skips memory when memoryEnabled is false', () => {
    const append = computePersonaAppend(new ConfigStore({ memoryEnabled: false }), fakeMemory);
    expect(append).not.toContain('likes tea');
  });

  it('still includes the persona base (name/personality)', () => {
    const append = computePersonaAppend(
      new ConfigStore({ assistantName: 'Bea', personality: 'calm and precise' }),
    );
    expect(append).toContain('Bea');
  });
});
