import { renderMarkdown } from './markdown.js';
import { decorateAssistantBubble } from './copy.js';
import { iconEl, setIcon } from './icons.js';

export type Who = 'you' | 'wk';

export interface MessageOptions {
  /** Came in over the voice layer rather than the composer. */
  spoken?: boolean;
  /** Re-send the last user message. Assistant rows only. */
  onRetry?: () => void;
}

/**
 * One chat row.
 *
 * User rows are a single gradient bubble. Assistant rows are an avatar plus a
 * column of tool chips, the bubble, and a meta line ("2 tools · 1.2s" + Copy +
 * Retry). Streaming only ever writes to the bubble, so chips added mid-turn
 * survive the markdown swap on `chat.assistant_done`.
 *
 * Security: every daemon-derived string (message text while streaming, tool
 * labels, tool summaries) is assigned via `textContent`. The single innerHTML
 * write is `renderMarkdown()` output, which escapes its input — same contract as
 * before this redesign.
 */
export class MessageView {
  readonly root: HTMLElement;
  private readonly who: Who;
  private readonly bodyEl: HTMLElement;
  private readonly chipsEl?: HTMLElement;
  private readonly metaEl?: HTMLElement;
  private readonly statEl?: HTMLElement;
  private readonly chips = new Map<string, HTMLElement>();
  private toolCount = 0;
  private elapsedMs?: number;
  private finalized = false;

  constructor(who: Who, opts: MessageOptions = {}) {
    this.who = who;
    this.root = document.createElement('div');
    this.root.className = `msg msg--${who}`;
    if (opts.spoken) this.root.classList.add('msg--spoken');

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'msg__body';

    if (who === 'you') {
      this.root.appendChild(this.bodyEl);
      return;
    }

    const avatar = document.createElement('div');
    avatar.className = 'msg__avatar';
    const col = document.createElement('div');
    col.className = 'msg__col';

    this.chipsEl = document.createElement('div');
    this.chipsEl.className = 'msg__chips';

    this.metaEl = document.createElement('div');
    this.metaEl.className = 'msg__meta is-hidden';
    this.statEl = document.createElement('span');
    this.statEl.className = 'msg__stat';
    this.metaEl.appendChild(this.statEl);
    if (opts.onRetry) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'msg__action';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => opts.onRetry?.());
      this.metaEl.appendChild(retry);
    }

    col.append(this.chipsEl, this.bodyEl, this.metaEl);
    this.root.append(avatar, col);
  }

  /** Plain text, used while the reply is still streaming. */
  setStreaming(text: string): void {
    this.bodyEl.classList.add('msg__body--streaming');
    this.bodyEl.textContent = text;
  }

  /** Final render: Markdown + copy affordances for assistant text, literal for the user's. */
  render(text: string): void {
    this.bodyEl.classList.remove('msg__body--streaming');
    if (this.who !== 'wk') {
      this.bodyEl.textContent = text;
      return;
    }
    this.finalized = true;
    this.bodyEl.innerHTML = renderMarkdown(text);
    decorateAssistantBubble(this.bodyEl, text);
    this.adoptCopyButton();
    this.renderStat();
  }

  /**
   * `decorateAssistantBubble` parks a hover-reveal copy button inside the
   * bubble; the redesign wants it on the meta line instead. Move the button
   * itself so its wired handler (and the raw Markdown it closed over) is kept.
   */
  private adoptCopyButton(): void {
    const actions = this.bodyEl.querySelector('.bubble__actions');
    const copy = actions?.querySelector<HTMLElement>('.bubble__copy');
    actions?.remove();
    if (!copy || !this.metaEl) return;
    this.metaEl.querySelector('.msg__action--copy')?.remove();
    copy.className = 'msg__action msg__action--copy';
    copy.textContent = 'Copy';
    this.metaEl.insertBefore(
      copy,
      this.metaEl.querySelector('.msg__action:not(.msg__action--copy)'),
    );
  }

  /** A tool the assistant called during this turn, pending its result. */
  addTool(toolId: string, label: string, summary: string): void {
    if (!this.chipsEl || this.chips.has(toolId)) return;
    const chip = document.createElement('div');
    chip.className = 'msg__chip';
    const mark = iconEl('dash', 'msg__chip-mark');
    const name = document.createElement('span');
    name.className = 'msg__chip-name';
    name.textContent = label;
    const detail = document.createElement('span');
    detail.className = 'msg__chip-detail';
    detail.textContent = summary;
    chip.append(mark, name, detail);
    this.chipsEl.appendChild(chip);
    this.chipsEl.classList.add('msg__chips--on');
    this.chips.set(toolId, chip);
    this.toolCount += 1;
    this.renderStat();
  }

  /** Settle a chip once its tool_result lands. */
  resolveTool(toolId: string, ok: boolean): void {
    const chip = this.chips.get(toolId);
    if (!chip) return;
    chip.classList.toggle('msg__chip--ok', ok);
    chip.classList.toggle('msg__chip--error', !ok);
    const mark = chip.querySelector<HTMLElement>('.msg__chip-mark');
    if (mark) setIcon(mark, ok ? 'check' : 'cross');
  }

  /** Wall-clock for the turn, measured from the submit. */
  setElapsed(ms: number): void {
    this.elapsedMs = ms;
    this.renderStat();
  }

  private renderStat(): void {
    if (!this.statEl || !this.metaEl) return;
    const parts: string[] = [];
    if (this.toolCount > 0)
      parts.push(`${this.toolCount} ${this.toolCount === 1 ? 'tool' : 'tools'}`);
    if (this.elapsedMs !== undefined) parts.push(`${(this.elapsedMs / 1000).toFixed(1)}s`);
    this.statEl.textContent = parts.join(' · ');
    // Held back until the turn settles, so the actions don't flicker mid-stream.
    this.metaEl.classList.toggle('is-hidden', !this.finalized);
  }
}
