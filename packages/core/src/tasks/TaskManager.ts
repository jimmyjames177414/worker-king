import type { Task, TaskProgress } from '@workerking/shared';
import { ProgressMapper } from './ProgressMapper.js';

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
}

export class TaskManager {
  private readonly tasks = new Map<string, RunningTask>();

  constructor(private readonly deps: TaskManagerDeps) {}

  /** Start a task; returns its id immediately (fire-and-forget for the caller). */
  create(prompt: string): string {
    const id = this.deps.newId();
    const abort = new AbortController();
    const task: Task = {
      id,
      prompt,
      createdAt: this.deps.now(),
      state: 'running',
      progress: [],
    };
    const running: RunningTask = {
      task,
      abort,
      mapper: new ProgressMapper(this.deps.now, this.deps.throttleMs),
    };
    this.tasks.set(id, running);
    this.deps.emit.created(task);

    void this.run(running);
    return id;
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
      this.tasks.delete(task.id);
    }
  }

  /** Snapshot for check_task_status. */
  check(taskId: string): Task | undefined {
    return this.tasks.get(taskId)?.task;
  }

  /** Cancel a running task; returns true if it was found. */
  cancel(taskId: string): boolean {
    const running = this.tasks.get(taskId);
    if (!running) return false;
    running.abort.abort();
    return true;
  }

  activeCount(): number {
    return this.tasks.size;
  }
}
