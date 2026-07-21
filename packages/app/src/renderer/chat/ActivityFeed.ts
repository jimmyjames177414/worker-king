import type { ActivityStep } from '@workerking/shared';
import { relTime } from './relTime.js';

/**
 * ActivityFeed — the live, tool-by-tool execution timeline.
 *
 * Steps are grouped by correlation id (a task id, or a chat turn's messageId).
 * Each group is a section headed by its state; rows within it hang off a
 * timeline rail and show what the agent did (tool + target, then a result
 * preview) plus its thinking. Rendering is hand-rolled to match the rest of this
 * renderer, and every string goes in via `textContent` — never innerHTML — so
 * tool output can't inject markup.
 */
interface Group {
  root: HTMLElement;
  body: HTMLElement;
  badge: HTMLElement;
  title: HTMLElement;
  /** tool_use rows keyed by toolId so a later tool_result attaches to its row. */
  toolRows: Map<string, HTMLElement>;
  active: boolean;
}

export class ActivityFeed {
  private readonly groups = new Map<string, Group>();
  /** Last-seen busy state, so `onBusyChange` fires only on the 0↔active edge. */
  private prevActive = 0;

  constructor(
    private readonly listEl: HTMLElement,
    private readonly countEl: HTMLElement,
    /** Fired when work starts (busy=true) or all groups settle (busy=false). */
    private readonly onBusyChange?: (busy: boolean) => void,
  ) {}

  /** Apply one activity step, creating its group/row as needed. */
  apply(step: ActivityStep): void {
    const cid = step.taskId ?? step.messageId ?? '_';
    const group = this.ensureGroup(cid);
    // A step arriving for a settled group means it wasn't really finished (only
    // real terminal events — task.done / assistant_done — or a socket drop
    // finalize a group, and those arrive after the last step), so re-activate it.
    if (!group.active) {
      group.active = true;
      group.root.classList.add('act-group--active');
      group.badge.textContent = 'working';
    }

    const s = step.step;
    if (s.kind === 'tool_use') {
      const row = this.newRow('tool', step.ts);
      const text = row.querySelector<HTMLElement>('.act-row__text')!;
      const label = document.createElement('span');
      label.className = 'act-row__label';
      label.textContent = s.label;
      const summary = document.createElement('span');
      summary.className = 'act-row__summary';
      summary.textContent = ` ${s.summary}`;
      text.append(label, summary);
      group.body.appendChild(row);
      group.toolRows.set(s.toolId, row);
    } else if (s.kind === 'tool_result') {
      const row = group.toolRows.get(s.toolId) ?? this.orphanRow(group);
      row.classList.toggle('act-row--ok', s.ok);
      row.classList.toggle('act-row--error', !s.ok);
      if (s.preview) {
        let res = row.querySelector<HTMLElement>('.act-row__result');
        if (!res) {
          res = document.createElement('div');
          res.className = 'act-row__result';
          row.appendChild(res);
        }
        res.textContent = s.preview;
      }
    } else {
      const row = this.newRow('think', step.ts);
      row.querySelector<HTMLElement>('.act-row__text')!.textContent = s.text;
      group.body.appendChild(row);
    }
    this.renderCount();
  }

  /** Set a group's human title (e.g. the task prompt). */
  setTitle(cid: string, title: string): void {
    const group = this.ensureGroup(cid);
    if (title) group.title.textContent = title;
  }

  /** Mark a group finished so it stops counting as active. */
  finalize(cid: string, state: string): void {
    const group = this.groups.get(cid);
    if (!group) return;
    group.active = false;
    group.badge.textContent = state;
    group.root.classList.remove('act-group--active');
    this.renderCount();
  }

  /** Settle every still-active group (e.g. the daemon connection dropped). */
  finalizeAllActive(state: string): void {
    for (const [cid, group] of this.groups) {
      if (group.active) this.finalize(cid, state);
    }
  }

  private ensureGroup(cid: string): Group {
    const existing = this.groups.get(cid);
    if (existing) return existing;

    const root = document.createElement('div');
    root.className = 'act-group act-group--active';
    const head = document.createElement('div');
    head.className = 'act-group__head';
    const badge = document.createElement('span');
    badge.className = 'act-group__badge';
    badge.textContent = 'working';
    const title = document.createElement('span');
    title.className = 'act-group__title';
    title.textContent = cid.startsWith('_') ? 'Activity' : 'Chat turn';
    head.append(badge, title);
    const body = document.createElement('div');
    body.className = 'act-group__body';
    root.append(head, body);
    this.listEl.prepend(root); // newest group on top

    const group: Group = {
      root,
      body,
      badge,
      title,
      toolRows: new Map(),
      active: true,
    };
    this.groups.set(cid, group);
    return group;
  }

  /**
   * One timeline row: a node dot on the rail, a kind badge + relative time, and
   * the text column callers fill in.
   */
  private newRow(kind: 'tool' | 'think', ts: number): HTMLElement {
    const row = document.createElement('div');
    row.className = `act-row act-row--${kind}`;

    const node = document.createElement('span');
    node.className = 'act-row__node';

    const meta = document.createElement('div');
    meta.className = 'act-row__meta';
    const badge = document.createElement('span');
    badge.className = 'act-row__badge';
    badge.textContent = kind === 'tool' ? 'Tool' : 'Agent';
    const time = document.createElement('span');
    time.className = 'act-row__time';
    time.textContent = relTime(ts);
    meta.append(badge, time);

    const text = document.createElement('div');
    text.className = 'act-row__text';

    row.append(node, meta, text);
    return row;
  }

  /** A tool_result with no matching tool_use (out-of-order safety). */
  private orphanRow(group: Group): HTMLElement {
    const row = this.newRow('tool', Date.now());
    const label = document.createElement('span');
    label.className = 'act-row__label';
    label.textContent = 'result';
    row.querySelector<HTMLElement>('.act-row__text')!.appendChild(label);
    group.body.appendChild(row);
    return row;
  }

  private renderCount(): void {
    const active = [...this.groups.values()].filter((g) => g.active).length;
    this.countEl.textContent = active ? String(active) : '';
    this.countEl.classList.toggle('has', active > 0);
    if (active > 0 !== this.prevActive > 0) this.onBusyChange?.(active > 0);
    this.prevActive = active;
  }
}
