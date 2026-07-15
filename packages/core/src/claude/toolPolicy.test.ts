import { describe, it, expect } from 'vitest';
import {
  createToolPolicy,
  isMutatingTool,
  summarizeToolCall,
  type ToolConfirmer,
} from './toolPolicy.js';

const yes: ToolConfirmer = { confirm: async () => true };
const no: ToolConfirmer = { confirm: async () => false };

describe('isMutatingTool', () => {
  it('flags file/shell tools, not read tools', () => {
    expect(isMutatingTool('Bash')).toBe(true);
    expect(isMutatingTool('Write')).toBe(true);
    expect(isMutatingTool('Edit')).toBe(true);
    expect(isMutatingTool('Read')).toBe(false);
    expect(isMutatingTool('Grep')).toBe(false);
    expect(isMutatingTool('mcp__workerking__recall')).toBe(false);
  });
});

describe('createToolPolicy', () => {
  it('auto allows everything', async () => {
    const decide = createToolPolicy({ mode: () => 'auto', confirmer: no });
    expect(await decide('Bash', { command: 'rm -rf /' })).toEqual({ behavior: 'allow' });
  });

  it('readonly denies mutating tools but allows read tools', async () => {
    const decide = createToolPolicy({ mode: () => 'readonly' });
    expect((await decide('Write', { file_path: 'a' })).behavior).toBe('deny');
    expect(await decide('Read', { file_path: 'a' })).toEqual({ behavior: 'allow' });
  });

  it('gated allows a mutating tool only when the user approves', async () => {
    const approve = createToolPolicy({ mode: () => 'gated', confirmer: yes });
    const decline = createToolPolicy({ mode: () => 'gated', confirmer: no });
    expect(await approve('Bash', { command: 'ls' })).toEqual({ behavior: 'allow' });
    expect((await decline('Bash', { command: 'ls' })).behavior).toBe('deny');
  });

  it('gated fails closed when no confirmer is wired', async () => {
    const decide = createToolPolicy({ mode: () => 'gated' });
    expect((await decide('Bash', { command: 'ls' })).behavior).toBe('deny');
  });

  it('never gates non-mutating tools', async () => {
    const decide = createToolPolicy({ mode: () => 'gated', confirmer: no });
    expect(await decide('Read', { file_path: 'a' })).toEqual({ behavior: 'allow' });
  });
});

describe('summarizeToolCall', () => {
  it('describes a Bash command and a file edit', () => {
    expect(summarizeToolCall('Bash', { command: 'git push' })).toContain('git push');
    expect(summarizeToolCall('Write', { file_path: '/tmp/x' })).toContain('/tmp/x');
  });
});
