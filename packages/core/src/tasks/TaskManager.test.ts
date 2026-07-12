import { describe, it, expect, vi } from 'vitest';
import { TaskManager, type TaskRunner, type TaskEmitter, type TaskRunEvents } from './TaskManager.js';
import { ProgressMapper, friendlyTool } from './ProgressMapper.js';
import type { Task, TaskProgress } from '@workerking/shared';

function collectEmitter() {
  const created: Task[] = [];
  const progress: Array<{ id: string; p: TaskProgress }> = [];
  const done: Task[] = [];
  const errors: Array<{ id: string; error: string }> = [];
  const cancelled: string[] = [];
  const emit: TaskEmitter = {
    created: (t) => created.push(t),
    progress: (id, p) => progress.push({ id, p }),
    done: (t) => done.push(t),
    error: (id, error) => errors.push({ id, error }),
    cancelled: (id) => cancelled.push(id),
  };
  return { emit, created, progress, done, errors, cancelled };
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
