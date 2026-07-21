export interface TaskCard {
  id: string;
  prompt: string;
  state: string;
  latest?: string;
  result?: string;
  error?: string;
}

export interface TasksViewOptions {
  /** Rail badge — how many tasks are still in flight. */
  onActiveCountChange?(count: number): void;
}

const BUSY_STATES = new Set(['running', 'queued', 'awaiting_permission']);

/**
 * Delegated tasks, one card each.
 *
 * The daemon reports a state, not a percentage, so the bar is honest about that:
 * an indeterminate sweep while the task is in flight, and a solid full bar in
 * the terminal colour once it settles.
 */
export class TasksView {
  private readonly tasks = new Map<string, TaskCard>();
  private readonly rows = new Map<string, HTMLElement>();

  constructor(
    private readonly listEl: HTMLElement,
    private readonly countEl: HTMLElement | null,
    private readonly opts: TasksViewOptions = {},
  ) {}

  upsert(task: TaskCard): void {
    const prev = this.tasks.get(task.id);
    // task.error / task.cancelled carry no prompt; keep the one we already have.
    const merged: TaskCard = { ...prev, ...task, prompt: task.prompt || (prev?.prompt ?? '') };
    this.tasks.set(task.id, merged);
    this.renderRow(task.id);
    this.renderSummary();
  }

  progress(id: string, text: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    t.latest = text;
    this.renderRow(id);
  }

  private renderRow(id: string): void {
    const t = this.tasks.get(id);
    if (!t) return;

    let row = this.rows.get(id);
    if (!row) {
      row = document.createElement('div');
      this.listEl.prepend(row); // newest first
      this.rows.set(id, row);
    }
    const busy = BUSY_STATES.has(t.state);
    row.className = `card task task--${t.state}${busy ? ' task--busy' : ''}`;
    row.replaceChildren();

    const head = document.createElement('div');
    head.className = 'task__head';
    const dot = document.createElement('span');
    dot.className = 'task__dot';
    const title = document.createElement('span');
    title.className = 'task__title';
    title.textContent = t.prompt || 'Task';
    const chip = document.createElement('span');
    chip.className = 'task__chip';
    chip.textContent = t.state.replace(/_/g, ' ');
    head.append(dot, title, chip);

    const bar = document.createElement('div');
    bar.className = 'task__bar';
    const fill = document.createElement('div');
    fill.className = 'task__fill';
    bar.appendChild(fill);

    row.append(head, bar);

    const detail = t.error ?? t.result ?? t.latest ?? '';
    if (detail) {
      const foot = document.createElement('div');
      foot.className = 'task__foot';
      foot.textContent = detail;
      row.appendChild(foot);
    }
  }

  private renderSummary(): void {
    const all = [...this.tasks.values()];
    const active = all.filter((t) => BUSY_STATES.has(t.state)).length;
    const done = all.filter((t) => t.state === 'done').length;
    this.opts.onActiveCountChange?.(active);
    if (!this.countEl) return;
    if (!all.length) {
      this.countEl.textContent = 'No delegated tasks yet.';
      return;
    }
    const parts = [`${active} running`];
    if (done) parts.push(`${done} done`);
    this.countEl.textContent = parts.join(' · ');
  }
}
