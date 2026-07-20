import { readFileSync, existsSync } from 'node:fs';
import { writeJsonAtomic } from '../util/atomicJson.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@workerking/shared';

/**
 * TaskStore — a durable record of delegated tasks (N12).
 *
 * The TaskManager runs tasks in memory and evicts them when they finish, so
 * `check_task_status` used to answer "unknown" for anything already done, and a
 * daemon restart lost all trace of in-flight work. This file-backed store (one
 * JSON under ~/.claude/workerking, matching MemoryStore/ConversationStore) keeps
 * a snapshot of every task and its final state/result, so a finished task is
 * still reportable and a restart can reconcile interrupted ones.
 *
 * Note: this makes the *record* durable, not the execution — a task that was
 * mid-run when the daemon died can't truly resume (its Claude session is gone),
 * so `reconcileOnBoot` marks such tasks as errored rather than silently re-running
 * them (which could duplicate side effects).
 */

export interface TaskStoreOptions {
  dir?: string;
  /** Cap on retained task records (oldest terminal ones pruned). Default 200. */
  maxTasks?: number;
}

const TERMINAL = new Set(['done', 'error', 'cancelled']);

export class TaskStore {
  private readonly path: string;
  private readonly maxTasks: number;
  private tasks: Task[] = [];

  constructor(opts: TaskStoreOptions = {}) {
    const dir = opts.dir ?? join(homedir(), '.claude', 'workerking');
    this.path = join(dir, 'tasks.json');
    this.maxTasks = Math.max(1, opts.maxTasks ?? 200);
    this.hydrate();
  }

  private hydrate(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      // Keep only structurally sound records — a hand-edited entry must not
      // crash reconcileOnBoot()/list() later.
      if (Array.isArray(parsed?.tasks)) {
        this.tasks = (parsed.tasks as Task[]).filter(
          (t) =>
            !!t && typeof t === 'object' && typeof t.id === 'string' && typeof t.state === 'string',
        );
      }
    } catch {
      // Corrupt file → start fresh; the next write repairs it.
    }
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.path, { tasks: this.tasks });
    } catch {
      // Best-effort; task records must never crash the daemon.
    }
  }

  /** Insert or replace a task snapshot (deep-cloned so later mutation is isolated). */
  upsert(task: Task): void {
    const snapshot: Task = JSON.parse(JSON.stringify(task));
    const i = this.tasks.findIndex((t) => t.id === task.id);
    if (i >= 0) this.tasks[i] = snapshot;
    else this.tasks.push(snapshot);
    this.prune();
    this.persist();
  }

  get(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  /** All task records, most recent first. */
  list(): Task[] {
    return [...this.tasks].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * On daemon boot: any task left in a non-terminal state (queued/running) when
   * the process died is interrupted — mark it errored and persist. Returns the
   * reconciled tasks so the caller can log/emit if it wants.
   */
  reconcileOnBoot(): Task[] {
    const interrupted: Task[] = [];
    for (const t of this.tasks) {
      if (!TERMINAL.has(t.state)) {
        t.state = 'error';
        t.error = 'Interrupted by a daemon restart.';
        interrupted.push(t);
      }
    }
    if (interrupted.length) this.persist();
    return interrupted;
  }

  /** Keep the file bounded: drop the oldest terminal tasks past the cap. */
  private prune(): void {
    if (this.tasks.length <= this.maxTasks) return;
    // Sort oldest-first; remove oldest terminal tasks until under the cap.
    const overflow = this.tasks.length - this.maxTasks;
    const oldestTerminalFirst = [...this.tasks]
      .filter((t) => TERMINAL.has(t.state))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, overflow);
    const drop = new Set(oldestTerminalFirst.map((t) => t.id));
    this.tasks = this.tasks.filter((t) => !drop.has(t.id));
  }
}
