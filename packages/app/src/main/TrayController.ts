import { Tray, Menu, nativeImage, type BrowserWindow } from 'electron';

// A minimal 16x16 crown-ish glyph as a base64 PNG so Phase 0 needs no asset file.
// Replaced by a real branded icon in a later phase (resources/tray.png).
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVR4nGNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRgEA0k8B/1b3P0kAAAAASUVORK5CYII=';

export interface TrayCallbacks {
  onToggleChat: () => void;
  onToggleOverlay: () => void;
  onQuit: () => void;
}

/**
 * System-tray icon + context menu. The tray is the always-available entry point
 * (show the chat window, hide/show the avatar, quit).
 */
export function createTray(callbacks: TrayCallbacks): Tray {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  const tray = new Tray(icon);
  tray.setToolTip('WorkerKing');

  const menu = Menu.buildFromTemplate([
    { label: 'Open WorkerKing', click: () => callbacks.onToggleChat() },
    { label: 'Toggle Companion', click: () => callbacks.onToggleOverlay() },
    { type: 'separator' },
    { label: 'Quit', click: () => callbacks.onQuit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => callbacks.onToggleChat());
  return tray;
}

export function toggleWindowVisibility(win: BrowserWindow): void {
  if (win.isVisible()) win.hide();
  else win.show();
}
