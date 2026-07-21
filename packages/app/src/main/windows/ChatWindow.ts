import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { loadRenderer, hardenNavigation } from './OverlayWindow.js';

/**
 * The full chat window: a frameless, resizable desktop shell, created hidden and
 * toggled from the avatar, tray, or global shortcut. Holds the transcript, the
 * command rail's six views, and settings + character-card import.
 *
 * Frameless means the renderer draws its own title bar (renderer/chat/TitleBar.ts)
 * and drives minimize/maximize/close over the `wk:window-*` IPC channels.
 */
export function createChatWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 760,
    minHeight: 520,
    show: false,
    frame: false,
    title: 'WorkerKing',
    webPreferences: {
      preload: join(__dirname, '../preload/chat.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // These preloads only use contextBridge/ipcRenderer, which work sandboxed
      // — no reason to hand a window that renders LLM/tool output full Node.
      sandbox: true,
    },
  });

  // Hide instead of destroy on close so state persists. This also catches the
  // custom title bar's close button, which calls win.close() over IPC.
  win.on('close', (e) => {
    if (!(win as BrowserWindow & { _reallyClose?: boolean })._reallyClose) {
      e.preventDefault();
      win.hide();
    }
  });

  // Keep the renderer's maximize/restore icon in sync with the real window state.
  const sendMaximized = (maximized: boolean) => win.webContents.send('wk:maximized', maximized);
  win.on('maximize', () => sendMaximized(true));
  win.on('unmaximize', () => sendMaximized(false));

  hardenNavigation(win);
  loadRenderer(win, 'chat');
  return win;
}

export function toggleChatWindow(win: BrowserWindow): void {
  if (win.isVisible()) win.hide();
  else {
    win.show();
    win.focus();
  }
}
