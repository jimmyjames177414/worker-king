import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WatchStore, isValidCron } from './WatchStore.js';

let clock = 0;
const now = () => (clock += 1000);
let n = 0;
const newId = () => `w${++n}`;

function store(dir?: string) {
  clock = 0;
  n = 0;
  return new WatchStore({ dir: dir ?? mkdtempSync(join(tmpdir(), 'wk-watch-')), now, newId });
}

describe('isValidCron', () => {
  it('accepts a 5-field expression', () => {
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('0 9 * * 1')).toBe(true);
  });
  it('rejects malformed expressions', () => {
    expect(isValidCron('* * * *')).toBe(false);
    expect(isValidCron('not a cron')).toBe(false);
  });
  it('rejects 5-field garbage the scheduler would throw on', () => {
    // Field count alone is not validation: these have 5 fields but croner
    // rejects them, and a persisted throwing watch poisons every boot.
    expect(isValidCron('not a cron at all')).toBe(false);
    expect(isValidCron('0 25 * * *')).toBe(false);
    expect(isValidCron('* * * * 9')).toBe(false);
  });
});

describe('WatchStore', () => {
  it('adds and lists user watches', () => {
    const s = store();
    const w = s.add('check my email', '*/10 * * * *');
    expect(w.builtin).toBe(false);
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0].prompt).toBe('check my email');
  });

  it('rejects an empty prompt or invalid cron', () => {
    const s = store();
    expect(() => s.add('', '*/5 * * * *')).toThrow(/prompt/);
    expect(() => s.add('do a thing', 'bad')).toThrow(/cron/);
  });

  it('removes by id', () => {
    const s = store();
    const w = s.add('watch', '*/5 * * * *');
    expect(s.remove(w.id)).toBe(true);
    expect(s.list()).toHaveLength(0);
    expect(s.remove('nope')).toBe(false);
  });

  it('persists across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wk-watch-'));
    store(dir).add('remember', '0 * * * *');
    const reopened = new WatchStore({ dir, now, newId });
    expect(reopened.list().map((w) => w.prompt)).toEqual(['remember']);
  });
});
