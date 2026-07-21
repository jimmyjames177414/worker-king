import { describe, it, expect } from 'vitest';
import {
  mapToEntries,
  renderVoiceSummary,
  buildCapabilityManifest,
  type CapabilityQueryFn,
  type CapabilityQueryHandle,
} from './CapabilityManifest.js';

function fakeQuery(handle: Partial<CapabilityQueryHandle>): CapabilityQueryFn {
  return () =>
    ({
      supportedCommands: async () => handle.supportedCommands?.() ?? [],
      supportedAgents: async () => handle.supportedAgents?.() ?? [],
      mcpServerStatus: async () => handle.mcpServerStatus?.() ?? [],
    }) as CapabilityQueryHandle;
}

describe('mapToEntries', () => {
  it('maps commands, agents, and mcp servers with status', () => {
    const entries = mapToEntries(
      [{ name: 'deploy', description: 'ship it', argumentHint: '<env>' }],
      [{ name: 'reviewer', description: 'reviews code' }],
      [
        { name: 'github', status: 'connected' },
        { name: 'db', status: 'failed' },
      ],
    );
    expect(entries.find((e) => e.name === 'deploy')).toMatchObject({
      kind: 'command',
      description: 'ship it',
      argumentHint: '<env>',
      source: 'user',
    });
    expect(entries.find((e) => e.name === 'deploy')?.routingHints).toContain('deploy');
    expect(entries.find((e) => e.name === 'reviewer')).toMatchObject({
      kind: 'agent',
      description: 'reviews code',
    });
    expect(entries.find((e) => e.name === 'github')?.status).toBe('connected');
    expect(entries.find((e) => e.name === 'db')?.status).toBe('error');
  });
});

describe('renderVoiceSummary', () => {
  it('pairs each entry with its description and renders command arg hints', () => {
    const summary = renderVoiceSummary([
      {
        kind: 'command',
        name: 'review',
        description: 'review a PR',
        argumentHint: '<pr-url>',
        source: 'user',
      },
      { kind: 'agent', name: 'reviewer', description: 'reviews code', source: 'user' },
    ]);
    expect(summary).toContain('- review <pr-url> — review a PR');
    expect(summary).toContain('- reviewer — reviews code');
    expect(summary).toMatch(/Ask me to list everything/);
  });

  it('collapses overflow past the char budget to a "(+N more)" marker', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      kind: 'skill' as const,
      name: `skill${i}`,
      description: 'a reasonably wordy description that consumes the character budget quickly',
      source: 'user' as const,
    }));
    const summary = renderVoiceSummary(many);
    expect(summary).toMatch(/Skills\/commands you can run \(\+\d+ more\)/);
    expect(summary.length).toBeLessThan(1800); // budget (~1500) + headers/footer
  });

  it('handles an empty manifest', () => {
    expect(renderVoiceSummary([])).toMatch(/No custom skills/);
  });

  it('lists only connected MCP services', () => {
    const summary = renderVoiceSummary([
      { kind: 'mcp_server', name: 'ok', description: '', source: 'user', status: 'connected' },
      { kind: 'mcp_server', name: 'down', description: '', source: 'user', status: 'error' },
    ]);
    expect(summary).toContain('ok');
    expect(summary).not.toContain('down');
  });
});

describe('buildCapabilityManifest', () => {
  it('assembles a manifest from the query introspection methods', async () => {
    let n = 0;
    const manifest = await buildCapabilityManifest({
      queryFn: fakeQuery({
        supportedCommands: () => [{ name: 'deploy', description: 'ship it', argumentHint: '' }],
        supportedAgents: () => [{ name: 'reviewer', description: 'reviews' }],
        mcpServerStatus: () => [{ name: 'github', status: 'connected' }],
      }),
      version: 7,
      now: () => 12345 + ++n,
    });
    expect(manifest.version).toBe(7);
    expect(manifest.builtAt).toBeGreaterThan(12345);
    expect(manifest.entries.map((e) => e.name).sort()).toEqual(['deploy', 'github', 'reviewer']);
    expect(manifest.voiceSummary).toContain('deploy');
  });

  it('tolerates an introspection method throwing', async () => {
    const manifest = await buildCapabilityManifest({
      queryFn: () =>
        ({
          supportedCommands: async () => {
            throw new Error('not ready');
          },
          supportedAgents: async () => [{ name: 'a', description: '' }],
          mcpServerStatus: async () => [],
        }) as CapabilityQueryHandle,
      version: 1,
      now: () => 1,
    });
    // commands failed → empty, but agents still came through.
    expect(manifest.entries.map((e) => e.name)).toEqual(['a']);
  });
});
