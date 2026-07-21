import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { EnvironmentContext, type EnvFs } from './EnvironmentContext.js';

/** Fake fs over a { root: dirNames[] } map; unknown roots throw (unreachable). */
function fakeFs(tree: Record<string, string[]>): EnvFs {
  const dirs = new Set(
    Object.entries(tree).flatMap(([root, names]) => [
      root,
      ...(names ?? []).map((n) => join(root, n)),
    ]),
  );
  return {
    async listDirs(root) {
      const names = tree[root];
      if (!names) throw new Error(`ENOENT: ${root}`);
      return names;
    },
    async isDir(path) {
      return dirs.has(path);
    },
  };
}

const ROOTS = {
  'C:\\_repos': ['worker-king', 'amethyst', 'workbench'],
  '\\\\wsl\\repos': ['Amethyst', 'notes'],
};

function build(tree: Record<string, string[]> = ROOTS, extra?: { envNotes?: string }) {
  let clock = 0;
  const env = new EnvironmentContext(
    () => ({ repoRoots: Object.keys(tree), envNotes: extra?.envNotes, claudeHost: 'auto' }),
    { fs: fakeFs(tree), now: () => clock, cacheTtlMs: 1000, platform: 'win32' },
  );
  return { env, tick: (ms: number) => (clock += ms) };
}

describe('EnvironmentContext.environmentBlock', () => {
  it('lists each root with its repos after refresh', async () => {
    const { env } = build();
    await env.refresh();
    const block = env.environmentBlock();
    expect(block).toContain('OS: win32 (claudeHost: auto)');
    expect(block).toContain('C:\\_repos: worker-king, amethyst, workbench');
    expect(block).toContain('Amethyst, notes');
    expect(block).toContain('resolve it against these roots');
  });

  it('marks an unreachable root instead of throwing', async () => {
    const { env } = build({ 'C:\\_repos': ROOTS['C:\\_repos'], 'X:\\gone': undefined as never });
    await env.refresh();
    const block = env.environmentBlock();
    expect(block).toContain('X:\\gone (unreachable right now)');
    expect(block).toContain('worker-king');
  });

  it('includes envNotes and is empty with no roots or notes', async () => {
    const { env } = build(ROOTS, { envNotes: 'prefer WSL for python work' });
    await env.refresh();
    expect(env.environmentBlock()).toContain('Notes: prefer WSL for python work');

    const empty = new EnvironmentContext(() => ({}), { fs: fakeFs({}), platform: 'win32' });
    expect(empty.environmentBlock()).toBe('');
  });

  it('never blocks the prompt path: unscanned roots show as scanning', () => {
    const { env } = build();
    // No refresh() yet — the synchronous call must still return immediately.
    expect(env.environmentBlock()).toContain('(scanning…)');
  });

  it('voiceOrientation lists all repo names, deduped across roots', async () => {
    const { env } = build();
    await env.refresh();
    const o = env.voiceOrientation();
    expect(o).toContain('worker-king');
    expect(o).toContain('notes');
    // "amethyst" is in C:\_repos and "Amethyst" in the WSL root → shown once.
    expect(o.match(/amethyst/gi)?.length).toBe(1);
  });
});

describe('EnvironmentContext.resolveRepoPath', () => {
  it('passes through an absolute existing path and rejects a missing one', async () => {
    const { env } = build();
    const dir = join('C:\\_repos', 'worker-king');
    expect(await env.resolveRepoPath(dir)).toEqual({ ok: true, path: dir });
    const missing = await env.resolveRepoPath('C:\\nope\\nothing');
    expect(missing.ok).toBe(false);
  });

  it('resolves a bare name case-insensitively across roots', async () => {
    const { env } = build();
    expect(await env.resolveRepoPath('WORKER-KING')).toEqual({
      ok: true,
      path: join('C:\\_repos', 'worker-king'),
    });
    expect(await env.resolveRepoPath('notes')).toEqual({
      ok: true,
      path: join('\\\\wsl\\repos', 'notes'),
    });
  });

  it('prefers exact matches and reports ambiguity with candidates', async () => {
    const { env } = build();
    // "amethyst" exists exactly in C:\_repos and as "Amethyst" in the WSL root —
    // both are exact case-insensitive matches → ambiguous, candidates listed.
    const r = await env.resolveRepoPath('amethyst');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('ambiguous');
      expect(r.error).toContain('amethyst');
    }
    // Unique prefix resolves.
    expect(await env.resolveRepoPath('workb')).toEqual({
      ok: true,
      path: join('C:\\_repos', 'workbench'),
    });
    // "worker" prefix is unique too (worker-king).
    expect(await env.resolveRepoPath('worker')).toEqual({
      ok: true,
      path: join('C:\\_repos', 'worker-king'),
    });
  });

  it('unknown names fail with a sample of known repos', async () => {
    const { env } = build();
    const r = await env.resolveRepoPath('zebra');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('worker-king');
  });
});
