import { setIcon } from './icons.js';

/** The window-control slice of the chat preload bridge. */
export interface WindowControls {
  minimizeWindow(): void;
  toggleMaximizeWindow(): void;
  closeWindow(): void;
  onMaximizeChange(cb: (maximized: boolean) => void): void;
}

/**
 * Custom title bar for the frameless chat window. The bar itself is a drag
 * region (CSS `-webkit-app-region`); the three buttons opt out of it and talk to
 * Electron main over IPC. Close hides the window — main's close interceptor is
 * what makes that true, so the tray can bring it back.
 */
export class TitleBar {
  constructor(bridge: WindowControls, root: Document | HTMLElement = document) {
    const maxBtn = root.querySelector<HTMLElement>('#tb-max');
    const maxIcon = maxBtn?.querySelector<HTMLElement>('.icon');

    root.querySelector('#tb-min')?.addEventListener('click', () => bridge.minimizeWindow());
    maxBtn?.addEventListener('click', () => bridge.toggleMaximizeWindow());
    root.querySelector('#tb-close')?.addEventListener('click', () => bridge.closeWindow());

    bridge.onMaximizeChange((maximized) => {
      if (maxBtn) maxBtn.title = maximized ? 'Restore' : 'Maximize';
      if (maxIcon) setIcon(maxIcon, maximized ? 'restore' : 'max');
    });
  }
}
