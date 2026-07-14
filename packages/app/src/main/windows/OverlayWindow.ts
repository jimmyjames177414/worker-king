import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';

const OVERLAY_WIDTH = 148;
const OVERLAY_HEIGHT = 148;
const MARGIN = 24;

/**
 * The always-on-top avatar companion window: transparent, frameless, no taskbar
 * entry, parked in the bottom-right corner. Starts click-through (mouse events
 * pass to the desktop) with `forward: true` so the renderer still receives
 * hover; ClickThroughManager toggles solidity when the pointer is over the avatar.
 */
export function createOverlayWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.workAreaSize;

  const win = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x: width - OVERLAY_WIDTH - MARGIN,
    y: height - OVERLAY_HEIGHT - MARGIN,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Float above fullscreen apps too.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Window is sized to the avatar — always solid, no click-through needed.
  win.setIgnoreMouseEvents(false);

  loadRenderer(win, 'overlay');
  return win;
}

/** Load a renderer entry in dev (vite server) or prod (built html). */
export function loadRenderer(win: BrowserWindow, entry: 'overlay' | 'chat'): void {
  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer) {
    win.loadURL(`${devServer}/${entry}/index.html`);
  } else {
    win.loadFile(join(__dirname, `../renderer/${entry}/index.html`));
  }
}
