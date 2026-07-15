import type { Task, TaskProgress } from '@workerking/shared';
import { ProgressMapper } from './ProgressMapper.js';
import type { TaskStore } from './TaskStore.js';

/**
 * TaskManager — the async delegation engine behind the chat-supervisor pattern.
 *
 * `create(prompt)` returns a task id immediately (so the voice model can say "On
 * it" and keep conversing), runs the work in the background via an injected
 * TaskRunner (ClaudeBackend in production, a fake in tests), maps its activity to
 * throttled spoken progress, and emits `task.*` events. `check`/`cancel` back the
 * check_task_status / cancel_task voice tools.
 */

export interface TaskRunEvents {
  onDelta(text: string): void;
  onToolUse(name: string): void;
  onDone(summary: string): void;
  onError(err: Error): void;
}

export interface TaskRunner {
  run(prompt: string, events: TaskRunEvents, signal: AbortSignal): Promise<void>;
}

/** What TaskManager emits; the daemon wires these to WS broadcasts. */
export interface TaskEmitter {
  created(task: Task): void;
  /** A task changed state without progress/finishing — e.g. queued → running. */
  updated(task: Task): void;
  progress(taskId: string, progress: TaskProgress): void;
  done(task: Task): void;
  error(taskId: string, error: string): void;
  cancelled(taskId: string): void;
}

interface RunningTask {
  task: Task;
  abort: AbortController;
  mapper: ProgressMapper;
}

export interface TaskManagerDeps {
  runner: TaskRunner;
  emit: TaskEmitter;
  now: () => number;
  newId: () => string;
  throttleMs?: number;
  /** Max tasks running at once; the rest wait in `queued`. Default 3. */
  maxConcurrent?: number;
  /** Durable record of tasks (N12); when set, snapshots survive restart. */
  store?: TaskStore;
}

export class TaskManager {
  private readonly tasks = new Map<string, RunningTask>();
  private readonly queue: string[] = [];
  private readonly maxConcurrent: number;
  private runningCount = 0;

  constructor(private readonly deps: TaskManagerDeps) {
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? 3);
  }

  /** Start a task; returns its id immediately (fire-and-forget for the caller). */
  create(prompt: string): string {
    const id = this.deps.newId();
    const task: Task = {
      id,
      prompt,
      createdAt: this.deps.now(),
      state: 'queued',
      progress: [],
    };
    const running: RunningTask = {
      task,
      abort: new AbortController(),
      mapper: new ProgressMapper(this.deps.now, this.deps.throttleMs),
    };
    this.tasks.set(id, running);

    // Start immediately if there's a free slot, otherwise announce it queued.
    if (this.runningCount < this.maxConcurrent) {
      task.state = 'running';
      this.runningCount++;
      this.deps.emit.created(task);
      void this.run(running);
    } else {
      this.deps.emit.created(task); // state: 'queued'
      this.queue.push(id);
    }
    this.deps.store?.upsert(task);
    return id;
  }

  /** Promote queued tasks into free slots. */
  private pump(): void {
    while (this.runningCount < this.maxConcurrent && this.queue.length) {
      const id = this.queue.shift()!;
      const running = this.tasks.get(id);
      if (!running || running.abort.signal.aborted) continue;
      running.task.state = 'running';
      this.runningCount++;
      this.deps.emit.updated(running.task); // queued → running
      this.deps.store?.upsert(running.task);
      void this.run(running);
    }
  }

  private async run(running: RunningTask): Promise<void> {
    const { task, abort, mapper } = running;
    const pushProgress = (p: TaskProgress | undefined) => {
      if (!p) return;
      task.progress.push(p);
      this.deps.emit.progress(task.id, p);
    };

    try {
      await this.deps.runner.run(
        task.prompt,
        {
          onDelta: () => pushProgress(mapper.heartbeat()),
          onToolUse: (name) => pushProgress(mapper.tool(name)),
          onDone: (summary) => {
            task.state = 'done';
            task.result = { summary };
          },
          onError: (err) => {
            task.state = 'error';
            task.error = err.message;
          },
        },
        abort.signal,
      );

      if (abort.signal.aborted) {
        task.state = 'cancelled';
        this.deps.emit.cancelled(task.id);
      } else if (task.state === 'error') {
        this.deps.emit.error(task.id, task.error ?? 'unknown error');
      } else {
        if (task.state !== 'done') {
          task.state = 'done';
          task.result ??= { summary: 'Done.' };
        }
        this.deps.emit.done(task);
      }
    } catch (err) {
      if (abort.signal.aborted) {
        task.state = 'cancelled';
        this.deps.emit.cancelled(task.id);
      } else {
        task.state = 'error';
        task.error = err instanceof Error ? err.message : String(err);
        this.deps.emit.error(task.id, task.error);
      }
    } finally {
      this.deps.store?.upsert(task); // persist the terminal state before eviction
      this.tasks.delete(task.id);
      this.runningCount--;
      this.pump(); // a slot freed — start the next queued task
    }
  }

  /** Snapshot for check_task_status; falls back to the durable store for finished tasks. */
  check(taskId: string): Task | undefined {
    return this.tasks.get(taskId)?.task ?? this.deps.store?.get(taskId);
  }

  /** Cancel a running or queued task; returns true if it was found. */
  cancel(taskId: string): boolean {
    const running = this.tasks.get(taskId);
    if (!running) return false;
    if (running.task.state === 'queued') {
      // Never started — drop it from the queue and report it cancelled directly.
      const i = this.queue.indexOf(taskId);
      if (i >= 0) this.queue.splice(i, 1);
      running.task.state = 'cancelled';
      this.deps.store?.upsert(running.task);
      this.tasks.delete(taskId);
      this.deps.emit.cancelled(taskId);
      return true;
    }
    running.abort.abort();
    return true;
  }

  /** Total tasks tracked (queued + running). */
  activeCount(): number {
    return this.tasks.size;
  }

  /** Tasks currently executing (excludes queued). */
  runningTasks(): number {
    return this.runningCount;
  }

  /** Tasks waiting for a free slot. */
  queuedTasks(): number {
    return this.queue.length;
  }
}
