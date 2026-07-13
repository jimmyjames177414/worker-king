/**
 * Captions — floating subtitles by the avatar showing what WorkerKing heard (you)
 * and what it's saying. Driven by `voice.transcript` broadcasts, so voice works
 * without opening the chat window, and it doubles as the debug surface for the
 * rest of the voice stack.
 */
export class Captions {
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly el: HTMLElement) {}

  show(role: 'user' | 'assistant', text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.el.textContent = trimmed;
    this.el.dataset.role = role;
    this.el.classList.add('captions--visible');

    // Auto-hide after a beat; longer lines linger a little longer.
    if (this.hideTimer) clearTimeout(this.hideTimer);
    const linger = Math.min(6000, 1500 + trimmed.length * 45);
    this.hideTimer = setTimeout(() => this.el.classList.remove('captions--visible'), linger);
  }

  clear(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.el.classList.remove('captions--visible');
    this.el.textContent = '';
  }
}
