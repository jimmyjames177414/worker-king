import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@workerking/shared';
import { TaskStore } from './TaskStore.js';

function task(id: string, state: Task['state'], createdAt = 1): Task {
  return { id, prompt: `do ${id}`, createdAt, state, progress: [] };
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'wk-tasks-'));
}

describe('TaskStore', () => {
  it('upserts, gets, and survives reopen', () => {
    const dir = tmp();
    const a = new TaskStore({ dir });
    a.upsert(task('t1', 'running'));
    a.upsert({ ...task('t1', 'done'), result: { summary: 'finished' } });

    const b = new TaskStore({ dir });
    const loaded = b.get('t1');
    expect(loaded?.state).toBe('done');
    expect(loaded?.result?.summary).toBe('finished');
  });

  it('snapshots deeply so later mutation does not leak in', () => {
    const store = new TaskStore({ dir: tmp() });
    const t = task('t1', 'running');
    store.upsert(t);
    t.state = 'cancelled'; // mutate after upsert
    expect(store.get('t1')?.state).toBe('running');
  });

  it('reconcileOnBoot marks non-terminal tasks as interrupted', () => {
    const dir = tmp();
    const a = new TaskStore({ dir });
    a.upsert(task('running1', 'running'));
    a.upsert(task('queued1', 'queued'));
    a.upsert({ ...task('done1', 'done'), result: { summary: 'ok' } });

    const b = new TaskStore({ dir });
    const interrupted = b.reconcileOnBoot();
    expect(interrupted.map((t) => t.id).sort()).toEqual(['queued1', 'running1']);
    expect(b.get('running1')?.state).toBe('error');
    expect(b.get('running1')?.error).toMatch(/restart/i);
    expect(b.get('done1')?.state).toBe('done'); // terminal untouched
  });

  it('prunes oldest terminal tasks past the cap, keeping active ones', () => {
    const store = new TaskStore({ dir: tmp(), maxTasks: 2 });
    store.upsert(task('old', 'done', 1));
    store.upsert(task('mid', 'done', 2));
    store.upsert(task('live', 'running', 3)); // non-terminal
    store.upsert(task('new', 'done', 4));
    const ids = store.list().map((t) => t.id);
    expect(ids).toContain('live'); // active never pruned
    expect(ids).not.toContain('old'); // oldest terminal dropped
  });
});
