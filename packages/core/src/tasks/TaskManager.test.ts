import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskManager, type TaskRunner, type TaskEmitter, type TaskRunEvents } from './TaskManager.js';
import { ProgressMapper, friendlyTool } from './ProgressMapper.js';
import { TaskStore } from './TaskStore.js';
import type { Task, TaskProgress } from '@workerking/shared';

function collectEmitter() {
  const created: Task[] = [];
  const updated: Task[] = [];
  const progress: Array<{ id: string; p: TaskProgress }> = [];
  const done: Task[] = [];
  const errors: Array<{ id: string; error: string }> = [];
  const cancelled: string[] = [];
  const emit: TaskEmitter = {
    created: (t) => created.push({ ...t }),
    updated: (t) => updated.push({ ...t }),
    progress: (id, p) => progress.push({ id, p }),
    done: (t) => done.push({ ...t }),
    error: (id, error) => errors.push({ id, error }),
    cancelled: (id) => cancelled.push(id),
  };
  return { emit, created, updated, progress, done, errors, cancelled };
}

let clock = 0;
const now = () => (clock += 2000); // each read advances 2s so throttle always passes
let idN = 0;
const newId = () => `task-${++idN}`;

describe('ProgressMapper', () => {
  it('throttles emissions by the clock', () => {
    let t = 0;
    const mapper = new ProgressMapper(() => t, 1000);
    t = 0;
    expect(mapper.tool('Bash')).toBeDefined(); // first always emits
    t = 500;
    expect(mapper.tool('Read')).toBeUndefined(); // within throttle
    t = 1600;
    expect(mapper.tool('Grep')).toBeDefined(); // past throttle
  });

  it('maps tool names to friendly phrases', () => {
    expect(friendlyTool('Bash')).toBe('running a command');
    expect(friendlyTool('mcp__workerking__capture_screen')).toBe('using capture screen');
    expect(friendlyTool('Whatever')).toBe('using Whatever');
  });
});

describe('TaskManager', () => {
  function makeManager(runner: TaskRunner) {
    const c = collectEmitter();
    clock = 0;
    idN = 0;
    const tm = new TaskManager({ runner, emit: c.emit, now, newId, throttleMs: 100 });
    return { tm, ...c };
  }

  it('returns an id immediately and emits created before running', async () => {
    let started = false;
    const runner: TaskRunner = {
      run: async (_p, events) => {
        started = true;
        events.onDone('finished');
      },
    };
    const { tm, created } = makeManager(runner);
    const id = tm.create('do a thing');
    expect(id).toBe('task-1');
    expect(created[0]?.id).toBe('task-1'); // created emitted synchronously
    // give the microtask queue a tick
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toBe(true);
  });

  it('emits throttled progress for tool uses and a final done', async () => {
    const runner: TaskRunner = {
      run: async (_p, events: TaskRunEvents) => {
        events.onToolUse('Read');
        events.onToolUse('Bash');
        events.onDone('renamed 240 files');
      },
    };
    const { tm, progress, done } = makeManager(runner);
    tm.create('rename my screenshots');
    await new Promise((r) => setTimeout(r, 0));

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0].p.text).toMatch(/reading a file/);
    expect(done[0]?.result?.summary).toBe('renamed 240 files');
    expect(done[0]?.state).toBe('done');
  });

  it('cancel aborts the run and emits cancelled', async () => {
    let aborted = false;
    const runner: TaskRunner = {
      run: (_p, _events, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        }),
    };
    const { tm, cancelled } = makeManager(runner);
    const id = tm.create('long job');
    await new Promise((r) => setTimeout(r, 0));
    expect(tm.cancel(id)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(aborted).toBe(true);
    expect(cancelled).toContain(id);
  });

  it('emits error when the runner reports one', async () => {
    const runner: TaskRunner = {
      run: async (_p, events) => events.onError(new Error('boom')),
    };
    const { tm, errors } = makeManager(runner);
    tm.create('bad job');
    await new Promise((r) => setTimeout(r, 0));
    expect(errors[0]?.error).toBe('boom');
  });

  it('check returns a running task and cancel of unknown id is false', async () => {
    const runner: TaskRunner = {
      run: (_p, _e, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve())),
    };
    const { tm } = makeManager(runner);
    const id = tm.create('job');
    await new Promise((r) => setTimeout(r, 0));
    expect(tm.check(id)?.id).toBe(id);
    expect(tm.cancel('nope')).toBe(false);
    tm.cancel(id);
  });
});

describe('TaskManager concurrency', () => {
  /** A runner whose tasks stay open until released, keyed by prompt. */
  function gatedRunner() {
    const release = new Map<string, () => void>();
    const runner: TaskRunner = {
      run: (prompt, events) =>
        new Promise<void>((resolve) => {
          release.set(prompt, () => {
            events.onDone(`done ${prompt}`);
            resolve();
          });
        }),
    };
    return { runner, release };
  }

  function makeManager(runner: TaskRunner, maxConcurrent: number) {
    const c = collectEmitter();
    clock = 0;
    idN = 0;
    const tm = new TaskManager({ runner, emit: c.emit, now, newId, throttleMs: 100, maxConcurrent });
    return { tm, ...c };
  }

  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('caps running tasks and queues the rest', async () => {
    const { runner, release } = gatedRunner();
    const { tm, created } = makeManager(runner, 1);
    tm.create('a');
    tm.create('b');
    tm.create('c');
    await tick();

    expect(tm.runningTasks()).toBe(1);
    expect(tm.queuedTasks()).toBe(2);
    // First announced running, the other two queued.
    expect(created.map((t) => t.state)).toEqual(['running', 'queued', 'queued']);

    release.get('a')!();
    await tick();
    expect(tm.runningTasks()).toBe(1); // b promoted
    expect(tm.queuedTasks()).toBe(1);
  });

  it('emits updated (queued → running) as slots free', async () => {
    const { runner, release } = gatedRunner();
    const { tm, updated } = makeManager(runner, 1);
    tm.create('a');
    tm.create('b');
    await tick();
    expect(updated).toHaveLength(0);

    release.get('a')!();
    await tick();
    expect(updated.map((t) => t.id)).toEqual(['task-2']);
    expect(updated[0].state).toBe('running');
  });

  it('drains the whole queue in order', async () => {
    const { runner, release } = gatedRunner();
    const { tm, done } = makeManager(runner, 2);
    for (const p of ['a', 'b', 'c', 'd']) tm.create(p);
    await tick();
    expect(tm.runningTasks()).toBe(2);

    for (const p of ['a', 'b', 'c', 'd']) {
      release.get(p)?.();
      await tick();
    }
    expect(done.map((t) => t.result?.summary)).toEqual(['done a', 'done b', 'done c', 'done d']);
    expect(tm.activeCount()).toBe(0);
  });

  it('cancels a queued task without ever running it', async () => {
    const { runner, release } = gatedRunner();
    const { tm, cancelled } = makeManager(runner, 1);
    tm.create('a');
    const queuedId = tm.create('b');
    await tick();
    expect(tm.queuedTasks()).toBe(1);

    expect(tm.cancel(queuedId)).toBe(true);
    expect(cancelled).toContain(queuedId);
    expect(tm.queuedTasks()).toBe(0);

    // Releasing the first must NOT start the cancelled one.
    release.get('a')!();
    await tick();
    expect(release.has('b')).toBe(false); // b never ran
  });

  it('persists to an injected store so check() survives eviction (N12)', async () => {
    const store = new TaskStore({ dir: mkdtempSync(join(tmpdir(), 'wk-tm-')) });
    const c = collectEmitter();
    clock = 0;
    idN = 0;
    const runner: TaskRunner = {
      run: async (_p, events) => events.onDone('all done'),
    };
    const tm = new TaskManager({ runner, emit: c.emit, now, newId, throttleMs: 100, store });
    const id = tm.create('do a thing');
    await new Promise((r) => setTimeout(r, 0)); // let the async run settle + evict

    expect(tm.activeCount()).toBe(0); // evicted from memory
    expect(tm.check(id)?.state).toBe('done'); // ...but found via the store
    expect(store.get(id)?.result?.summary).toBe('all done');
  });
});
