import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './MemoryStore.js';
import { buildMemoryTool } from '../claude/tools.js';
import { ConfigStore } from '../config/ConfigStore.js';
import { FakeScreenContextProvider } from '../screen/ScreenContextProvider.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'wk-mem-'));
}

let clock = 0;
const now = () => (clock += 1000);

describe('MemoryStore', () => {
  beforeEach(() => {
    clock = 0;
  });

  it('remembers, recalls, and updates (not appends) by key', () => {
    const dir = tempDir();
    const store = new MemoryStore({ dir, now });
    store.remember('editor', 'VS Code', 'preference');
    store.remember('timezone', 'PST', 'fact');
    expect(store.recall().map((e) => e.key).sort()).toEqual(['editor', 'timezone']);

    // Update-not-append: same key overwrites.
    store.remember('editor', 'Cursor', 'preference');
    const editor = store.recall('editor');
    expect(editor).toHaveLength(1);
    expect(editor[0].value).toBe('Cursor');
  });

  it('persists to disk and reloads', () => {
    const dir = tempDir();
    new MemoryStore({ dir, now }).remember('name', 'Sam', 'fact');
    const reopened = new MemoryStore({ dir, now });
    expect(reopened.recall('name')[0]?.value).toBe('Sam');
    // Markdown mirror is written and human-readable.
    const md = readFileSync(join(dir, 'memories.md'), 'utf8');
    expect(md).toContain('WorkerKing memory');
    expect(md).toContain('Sam');
  });

  it('excludes stale entries from recall + summary but keeps them for audit', () => {
    const dir = tempDir();
    const store = new MemoryStore({ dir, now });
    store.remember('old', 'outdated', 'fact');
    store.markStale('old');
    expect(store.recall()).toHaveLength(0);
    expect(store.summary()).toBe('');
    expect(store.all()).toHaveLength(1); // still on disk for audit
  });

  it('summary is budget-capped', () => {
    const dir = tempDir();
    const store = new MemoryStore({ dir, now });
    for (let i = 0; i < 100; i++) store.remember(`k${i}`, 'x'.repeat(30), 'fact');
    const summary = store.summary(300);
    expect(summary.length).toBeLessThan(360);
    expect(summary).toMatch(/more in memory/);
  });
});

describe('remember tool', () => {
  function deps(memory: MemoryStore | undefined, memoryEnabled = true) {
    return {
      config: new ConfigStore({ memoryEnabled }),
      screen: new FakeScreenContextProvider({ ok: true }),
      memory,
    };
  }

  it('stores a fact when enabled', async () => {
    const store = new MemoryStore({ dir: tempDir(), now });
    const t = buildMemoryTool(deps(store));
    const r = await t.handler({ key: 'coffee', value: 'oat latte', scope: 'preference' }, undefined);
    expect(r.isError).toBeUndefined();
    expect(store.recall('coffee')[0]?.value).toBe('oat latte');
  });

  it('refuses when memory is disabled', async () => {
    const store = new MemoryStore({ dir: tempDir(), now });
    const t = buildMemoryTool(deps(store, false));
    const r = await t.handler({ key: 'x', value: 'y', scope: 'fact' }, undefined);
    expect(r.isError).toBe(true);
  });
});
