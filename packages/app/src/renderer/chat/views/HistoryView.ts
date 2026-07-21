import type { ConversationSummary } from '@workerking/shared';
import { iconEl } from '../icons.js';
import { relTime } from '../relTime.js';

export interface HistoryViewOptions {
  onOpen(conversationId: string): void;
  onNew(): void;
}

/**
 * Past conversations, as card rows.
 *
 * The search box filters the list the daemon already sent — there is no
 * server-side history query, so nothing new crosses the bus.
 */
export class HistoryView {
  private readonly listEl: HTMLElement;
  private conversations: ConversationSummary[] = [];
  private query = '';

  constructor(
    root: HTMLElement,
    private readonly opts: HistoryViewOptions,
  ) {
    this.listEl = root.querySelector<HTMLElement>('#history-list')!;
    root.querySelector<HTMLInputElement>('#history-search')?.addEventListener('input', (e) => {
      this.query = (e.target as HTMLInputElement).value.trim().toLowerCase();
      this.render();
    });
    root.querySelector('#history-new')?.addEventListener('click', () => this.opts.onNew());
  }

  setConversations(conversations: ConversationSummary[]): void {
    this.conversations = conversations;
    this.render();
  }

  private render(): void {
    const matches = this.query
      ? this.conversations.filter((c) => c.title.toLowerCase().includes(this.query))
      : this.conversations;

    this.listEl.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'view__empty';
      empty.textContent = this.conversations.length
        ? 'No conversations match that search.'
        : 'No past conversations yet.';
      this.listEl.appendChild(empty);
      return;
    }

    const now = Date.now();
    for (const c of matches) {
      const row = document.createElement('div');
      row.className = 'hist';

      const main = document.createElement('div');
      main.className = 'hist__main';
      const title = document.createElement('div');
      title.className = 'hist__title';
      title.textContent = c.title;
      const meta = document.createElement('div');
      meta.className = 'hist__meta';
      meta.textContent = `${c.messageCount} ${c.messageCount === 1 ? 'message' : 'messages'}`;
      main.append(title, meta);

      const time = document.createElement('span');
      time.className = 'hist__time';
      time.textContent = relTime(c.updatedAt, now);

      row.append(iconEl('chat', 'hist__tile'), main, time);
      row.addEventListener('click', () => this.opts.onOpen(c.id));
      this.listEl.appendChild(row);
    }
  }
}
