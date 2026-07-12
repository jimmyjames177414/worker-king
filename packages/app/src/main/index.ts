import { app, globalShortcut, BrowserWindow } from 'electron';
import Store from 'electron-store';
import { DaemonSupervisor, type DaemonConnection } from './DaemonSupervisor.js';
import { detectClaude } from './WslDetector.js';
import { createOverlayWindow } from './windows/OverlayWindow.js';
import { createChatWindow, toggleChatWindow } from './windows/ChatWindow.js';
import { registerClickThrough } from './ClickThroughManager.js';
import { createTray } from './TrayController.js';
import { registerIpc } from './ipc.js';

/**
 * WorkerKing Electron main. Phase 0 wiring:
 *  1. Read config (hotkey, claudeHost).
 *  2. Decide where Claude lives (auto = probe Windows then WSL).
 *  3. Spawn + supervise the core daemon; learn its port + token.
 *  4. Create the overlay + chat windows; register click-through, tray, hotkey.
 *  5. Renderers fetch their connection over IPC and open their own WS.
 */

interface AppConfig {
  hotkey: string;
  claudeHost: 'auto' | 'windows' | 'wsl';
  [k: string]: unknown;
}

const config = new Store<AppConfig>({
  name: 'config',
  defaults: { hotkey: 'Control+Shift+Space', claudeHost: 'auto' },
});

let supervisor: DaemonSupervisor | undefined;
let connection: DaemonConnection | undefined;
let overlay: BrowserWindow | undefined;
let chat: BrowserWindow | undefined;
let quitting = false;

async function resolveDaemonMode(): Promise<'windows' | 'wsl'> {
  const pref = config.get('claudeHost');
  if (pref === 'windows' || pref === 'wsl') return pref;
  // auto: run the daemon where Claude Code actually lives.
  const loc = await detectClaude();
  if (loc.host === 'wsl') return 'wsl';
  return 'windows';
}

async function boot(): Promise<void> {
  const mode = await resolveDaemonMode();
  supervisor = new DaemonSupervisor({ mode });
  supervisor.on('log', (line: string) => process.stderr.write(`[daemon] ${line}`));
  supervisor.on('crash', (code: number | null) =>
    process.stderr.write(`[daemon] crashed (code ${code}), restarting\n`),
  );
  supervisor.on('restarted', (conn: DaemonConnection) => {
    connection = conn;
  });

  connection = await supervisor.start();

  registerIpc((win) => {
    if (!connection) return undefined;
    const role = win === overlay ? 'overlay' : 'chat';
    return { connection, role };
  });

  overlay = createOverlayWindow();
  chat = createChatWindow();
  registerClickThrough(overlay);

  createTray({
    onToggleChat: () => chat && toggleChatWindow(chat),
    onToggleOverlay: () => {
      if (!overlay) return;
      if (overlay.isVisible()) overlay.hide();
      else overlay.show();
    },
    onQuit: () => {
      quitting = true;
      app.quit();
    },
  });

  const hotkey = config.get('hotkey');
  globalShortcut.register(hotkey, () => {
    // Phase 0: hotkey toggles the chat window. Phase 2 repurposes it for
    // push-to-talk on the overlay.
    if (chat) toggleChatWindow(chat);
  });
}

app.whenReady().then(boot).catch((err) => {
  process.stderr.write(`[workerking] failed to boot: ${String(err)}\n`);
  app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  if (chat) (chat as BrowserWindow & { _reallyClose?: boolean })._reallyClose = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  supervisor?.stop();
});

// Keep running in the tray when all windows are closed.
app.on('window-all-closed', () => {
  if (quitting && process.platform !== 'darwin') app.quit();
});
