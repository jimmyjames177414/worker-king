import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './MemoryStore.js';
import { buildMemoryTool, buildRecallTool, buildListMemoriesTool } from '../claude/tools.js';
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

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

describe('recall tool', () => {
  function deps(memory: MemoryStore | undefined, memoryEnabled = true) {
    return {
      config: new ConfigStore({ memoryEnabled }),
      screen: new FakeScreenContextProvider({ ok: true }),
      memory,
    };
  }

  function seeded(): MemoryStore {
    const store = new MemoryStore({ dir: tempDir(), now });
    store.remember('editor', 'Cursor', 'preference');
    store.remember('coffee', 'oat latte', 'preference');
    store.remember('timezone', 'PST', 'fact');
    store.remember('project-repo', 'worker-king monorepo', 'project');
    return store;
  }

  it('returns ranked matches, key hits first', async () => {
    const store = seeded();
    store.remember('notes', 'prefers the Cursor editor over VS Code', 'fact');
    const t = buildRecallTool(deps(store));
    const r = await t.handler({ query: 'editor', limit: 5 }, undefined);
    expect(r.isError).toBeUndefined();
    // "editor" key ranks above the note that only mentions it in the value.
    const text = textOf(r);
    expect(text.indexOf('editor: Cursor')).toBeLessThan(text.indexOf('prefers the Cursor'));
  });

  it('filters by scope', async () => {
    const t = buildRecallTool(deps(seeded()));
    const r = await t.handler({ query: 'worker', scope: 'project', limit: 5 }, undefined);
    expect(textOf(r)).toContain('project-repo');
    expect(textOf(r)).not.toContain('coffee');
  });

  it('reports no matches cleanly', async () => {
    const t = buildRecallTool(deps(seeded()));
    const r = await t.handler({ query: 'nonexistentxyz', limit: 5 }, undefined);
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toMatch(/No memories match/i);
  });

  it('refuses when memory is disabled', async () => {
    const t = buildRecallTool(deps(seeded(), false));
    const r = await t.handler({ query: 'editor', limit: 5 }, undefined);
    expect(r.isError).toBe(true);
  });

  it('list_memories dumps all live entries and filters by scope', async () => {
    const store = seeded();
    store.markStale('timezone');
    const t = buildListMemoriesTool(deps(store));

    const all = await t.handler({}, undefined);
    expect(textOf(all)).toContain('editor');
    expect(textOf(all)).not.toContain('timezone'); // stale excluded

    const prefs = await t.handler({ scope: 'preference' }, undefined);
    expect(textOf(prefs)).toContain('coffee');
    expect(textOf(prefs)).not.toContain('project-repo');
  });

  it('list_memories reports an empty store', async () => {
    const t = buildListMemoriesTool(deps(new MemoryStore({ dir: tempDir(), now })));
    const r = await t.handler({}, undefined);
    expect(textOf(r)).toMatch(/no memories/i);
  });
});
