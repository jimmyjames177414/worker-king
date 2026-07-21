import type { Watch } from '@workerking/shared';

export interface WatchesViewOptions {
  onAdd(prompt: string, cron: string): void;
  onRemove(id: string): void;
  /** Rail badge — the number of configured watches. */
  onCountChange?(count: number): void;
}

/**
 * Proactive watches: the add form as a card at the top, then one card per watch.
 *
 * The mock's on/off switch and "2m ago" last-run are deliberately absent — the
 * daemon has no enable/disable message and never reports a last-run time. What
 * ships is what exists: a live dot, the prompt, its cron, and Remove (or a
 * `built-in` badge for the ones WorkerKing ships).
 */
export class WatchesView {
  private readonly listEl: HTMLElement;
  private readonly countEl: HTMLElement | null;

  constructor(
    root: HTMLElement,
    private readonly opts: WatchesViewOptions,
  ) {
    this.listEl = root.querySelector<HTMLElement>('#watches-list')!;
    this.countEl = root.querySelector<HTMLElement>('#watches-count');

    const promptInput = root.querySelector<HTMLInputElement>('#watch-prompt');
    const cronInput = root.querySelector<HTMLInputElement>('#watch-cron');
    root.querySelector('#watch-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const prompt = promptInput?.value.trim() ?? '';
      const cron = cronInput?.value.trim() ?? '';
      if (!prompt || !cron) return;
      this.opts.onAdd(prompt, cron);
      if (promptInput) promptInput.value = '';
    });
  }

  setWatches(watches: Watch[]): void {
    if (this.countEl) {
      this.countEl.textContent = watches.length
        ? `${watches.length} ${watches.length === 1 ? 'watch' : 'watches'} configured`
        : 'No watches configured yet.';
    }
    this.opts.onCountChange?.(watches.length);

    this.listEl.replaceChildren();
    for (const w of watches) {
      const card = document.createElement('div');
      card.className = 'card watch';

      const dot = document.createElement('span');
      dot.className = 'watch__dot';

      const main = document.createElement('div');
      main.className = 'watch__main';
      const prompt = document.createElement('div');
      prompt.className = 'watch__prompt';
      prompt.textContent = w.prompt;
      const cron = document.createElement('div');
      cron.className = 'watch__cron';
      cron.textContent = w.cron;
      main.append(prompt, cron);

      card.append(dot, main);

      if (w.builtin) {
        const badge = document.createElement('span');
        badge.className = 'watch__badge';
        badge.textContent = 'built-in';
        card.appendChild(badge);
      } else {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'watch__remove';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => this.opts.onRemove(w.id));
        card.appendChild(remove);
      }

      this.listEl.appendChild(card);
    }
  }
}
