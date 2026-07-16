import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { loadRenderer, hardenNavigation } from './OverlayWindow.js';

/**
 * The full chat window: a normal resizable window, created hidden and toggled
 * from the avatar, tray, or global shortcut. Holds the transcript, task list,
 * and (later) settings + character-card import.
 */
export function createChatWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 640,
    show: false,
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

  // Hide instead of destroy on close so state persists.
  win.on('close', (e) => {
    if (!(win as BrowserWindow & { _reallyClose?: boolean })._reallyClose) {
      e.preventDefault();
      win.hide();
    }
  });

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
