import { BrowserWindow, screen, shell } from 'electron';
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
      // These preloads only use contextBridge/ipcRenderer, which work sandboxed
      // — no reason to hand a window that renders LLM/tool output full Node.
      sandbox: true,
    },
  });

  // Float above fullscreen apps too.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Window is sized to the avatar — always solid, no click-through needed.
  win.setIgnoreMouseEvents(false);

  hardenNavigation(win);
  loadRenderer(win, 'overlay');
  return win;
}

/**
 * Navigation hardening (N11). The renderers only ever load their own bundled
 * HTML, so deny window.open (route real links to the OS browser instead) and
 * block any in-place navigation to a foreign origin — belt-and-braces with the
 * CSP if a renderer is ever coerced into navigating somewhere it shouldn't.
 */
export function hardenNavigation(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  const devServer = process.env['ELECTRON_RENDERER_URL'];
  win.webContents.on('will-navigate', (e, url) => {
    const ok = url.startsWith('file://') || (!!devServer && url.startsWith(devServer));
    if (!ok) e.preventDefault();
  });
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
