import type { AvatarState } from '@workerking/shared';

/**
 * AvatarController — the companion's animation state machine.
 *
 * Phase 0 drives a simple CSS-class-based avatar (a pulsing orb) through the
 * five states. The renderer is deliberately abstract: swapping the DOM element's
 * class set for a Lottie player or Live2D model later touches only this file.
 */
const STATES: readonly AvatarState[] = ['idle', 'listening', 'thinking', 'talking', 'alert'];

export class AvatarController {
  private current: AvatarState = 'idle';

  constructor(private readonly el: HTMLElement) {
    this.apply();
  }

  set(state: AvatarState): void {
    if (state === this.current) return;
    this.current = state;
    this.apply();
  }

  get(): AvatarState {
    return this.current;
  }

  private apply(): void {
    for (const s of STATES) this.el.classList.toggle(`avatar--${s}`, s === this.current);
    this.el.dataset.state = this.current;
  }
}
