import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from './ConfigStore.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'wk-cfg-'));
}

describe('ConfigStore', () => {
  it('seeds defaults and applies initial overrides', () => {
    const store = new ConfigStore({ screenAwareness: true });
    expect(store.get('screenAwareness')).toBe(true);
    expect(store.get('assistantName')).toBe('WorkerKing'); // default
  });

  it('notifies change listeners', () => {
    const store = new ConfigStore();
    const seen: Array<[string, unknown]> = [];
    store.onChange((k, v) => seen.push([k, v]));
    store.set('userName', 'Sam');
    expect(seen).toEqual([['userName', 'Sam']]);
  });

  it('does not touch disk when persistence is off', () => {
    const store = new ConfigStore({ userName: 'Sam' });
    store.set('userName', 'Alex');
    // A fresh non-persistent store starts from defaults again.
    expect(new ConfigStore().get('userName')).toBeUndefined();
  });

  it('persists to disk and reloads when persistence is on', () => {
    const dir = tempDir();
    const store = new ConfigStore(undefined, { persist: true, dir });
    store.set('userName', 'Sam');
    store.set('characterCard', { data: { name: 'Jarvis' } });

    const reopened = new ConfigStore(undefined, { persist: true, dir });
    expect(reopened.get('userName')).toBe('Sam');
    expect(reopened.get('characterCard')).toEqual({ data: { name: 'Jarvis' } });
  });

  it('explicit initial overrides win over the persisted file', () => {
    const dir = tempDir();
    new ConfigStore(undefined, { persist: true, dir }).set('userName', 'Sam');
    const store = new ConfigStore({ userName: 'Override' }, { persist: true, dir });
    expect(store.get('userName')).toBe('Override');
  });

  it('falls back to defaults on a corrupt file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'config.json'), '{ not valid json', 'utf8');
    const store = new ConfigStore(undefined, { persist: true, dir });
    expect(store.get('assistantName')).toBe('WorkerKing');
  });

  it('rejects a claudeCwd that does not point at an existing directory', () => {
    const store = new ConfigStore();
    store.set('claudeCwd', '/definitely/not/a/real/path/xyz');
    expect(store.get('claudeCwd')).toBeUndefined();
  });

  it('rejects a claudeCwd that points at a file, not a directory', () => {
    const dir = tempDir();
    const filePath = join(dir, 'not-a-dir.txt');
    writeFileSync(filePath, 'hi', 'utf8');
    const store = new ConfigStore();
    store.set('claudeCwd', filePath);
    expect(store.get('claudeCwd')).toBeUndefined();
  });

  it('accepts a claudeCwd that is a real directory', () => {
    const dir = tempDir();
    const store = new ConfigStore();
    store.set('claudeCwd', dir);
    expect(store.get('claudeCwd')).toBe(dir);
  });

  it('allows clearing claudeCwd back to unset', () => {
    const dir = tempDir();
    const store = new ConfigStore({ claudeCwd: dir });
    store.set('claudeCwd', undefined);
    expect(store.get('claudeCwd')).toBeUndefined();
  });
});
