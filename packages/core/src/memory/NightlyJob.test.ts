import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from './MemoryStore.js';
import { InteractionLog } from './InteractionLog.js';
import { consolidate, parseDistilled, type Distiller } from './NightlyJob.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'wk-nj-'));
}
let clock = 0;
const now = () => (clock += 1000);

describe('InteractionLog', () => {
  it('appends and reads back recent entries', () => {
    clock = 0;
    const log = new InteractionLog({ dir: tempDir(), now, today: () => '2026-07-13' });
    log.append('chat', 'hello');
    log.append('task', 'renamed files');
    const recent = log.readRecent();
    expect(recent.map((e) => e.text)).toEqual(['hello', 'renamed files']);
    expect(recent[1].kind).toBe('task');
  });
});

describe('parseDistilled', () => {
  it('extracts a JSON array from model prose', () => {
    const out = parseDistilled('Sure! Here:\n[{"key":"a","value":"1","scope":"fact"}]\ndone');
    expect(out).toEqual([{ key: 'a', value: '1', scope: 'fact' }]);
  });
  it('defaults an invalid scope to fact and drops malformed items', () => {
    const out = parseDistilled('[{"key":"a","value":"1","scope":"weird"},{"key":"b"}]');
    expect(out).toEqual([{ key: 'a', value: '1', scope: 'fact' }]);
  });
  it('returns empty on no array', () => {
    expect(parseDistilled('no json here')).toEqual([]);
  });
});

describe('consolidate', () => {
  it('replaces live memories with the distilled set and stales the rest', async () => {
    clock = 0;
    const dir = tempDir();
    const memory = new MemoryStore({ dir, now });
    memory.remember('editor', 'VS Code', 'preference');
    memory.remember('transient', 'debugging today', 'fact');
    const log = new InteractionLog({ dir, now, today: () => '2026-07-13' });
    log.append('chat', 'I switched to Cursor');

    // Distiller keeps editor (updated) + drops the transient one.
    const distill: Distiller = async () => [{ key: 'editor', value: 'Cursor', scope: 'preference' }];
    const res = await consolidate({ memory, log, distill, now });

    expect(res.kept).toBe(1);
    expect(memory.recall().map((e) => `${e.key}=${e.value}`)).toEqual(['editor=Cursor']);
    // The dropped one is staled (kept for audit), not deleted.
    expect(memory.all().some((e) => e.key === 'transient' && e.stale)).toBe(true);
    expect(memory.recall('editor')[0].provenance).toBe('nightly-consolidation');
  });

  it('preserves live memories when the distiller returns nothing (flaky reply)', async () => {
    clock = 0;
    const dir = tempDir();
    const memory = new MemoryStore({ dir, now });
    memory.remember('editor', 'Cursor', 'preference');
    memory.remember('timezone', 'PST', 'fact');
    const log = new InteractionLog({ dir, now, today: () => '2026-07-13' });
    log.append('chat', 'some chatter');

    // Distiller yields [] (e.g. Claude returned prose parseDistilled couldn't parse).
    const distill: Distiller = async () => [];
    const res = await consolidate({ memory, log, distill, now });

    // Memories must be untouched — never stale-swept to nothing.
    expect(res).toEqual({ kept: 2, staled: 0 });
    expect(memory.recall().map((e) => e.key).sort()).toEqual(['editor', 'timezone']);
    expect(memory.summary()).toContain('Cursor');
  });

  it('is a no-op when there is nothing to consolidate', async () => {
    const dir = tempDir();
    const memory = new MemoryStore({ dir, now });
    const log = new InteractionLog({ dir, now, today: () => '2026-07-13' });
    let called = false;
    const distill: Distiller = async () => {
      called = true;
      return [];
    };
    const res = await consolidate({ memory, log, distill, now });
    expect(called).toBe(false);
    expect(res).toEqual({ kept: 0, staled: 0 });
  });
});
