import { app, globalShortcut, BrowserWindow } from 'electron';
import Store from 'electron-store';
import { DaemonSupervisor, type DaemonConnection } from './DaemonSupervisor.js';
import { detectClaude } from './WslDetector.js';
import { createOverlayWindow } from './windows/OverlayWindow.js';
import { createChatWindow, toggleChatWindow } from './windows/ChatWindow.js';
import { registerClickThrough } from './ClickThroughManager.js';
import { createTray } from './TrayController.js';
import { registerIpc } from './ipc.js';
import { DaemonClient } from './DaemonClient.js';
import { captureScreen } from './ScreenCapture.js';

/**
 * WorkerKing Electron main. Phase 0 wiring:
 *  1. Read config (hotkey, claudeHost).
 *  2. Decide where Claude lives (auto = probe Windows then WSL).
 *  3. Spawn + supervise the core daemon; learn its port + token.
 *  4. Create the overlay + chat windows; register click-through, tray, hotkey.
 *  5. Renderers fetch their connection over IPC and open their own WS.
 */

// The persisted, user-editable config. Main owns this file (electron-store); the
// daemon receives a copy over WS on connect and on every change.
interface AppConfig {
  assistantName: string;
  personality: string;
  voiceProvider: 'gpt-realtime' | 'local-cascade';
  openaiModel: string;
  hotkey: string;
  claudeHost: 'auto' | 'windows' | 'wsl';
  wakeWordEnabled: boolean;
  screenAwareness: boolean;
  userName?: string;
  characterCard?: unknown;
  [k: string]: unknown;
}

const config = new Store<AppConfig>({
  name: 'config',
  defaults: {
    assistantName: 'WorkerKing',
    personality:
      'A capable, upbeat desktop companion. Concise out loud, thorough when it matters.',
    voiceProvider: 'gpt-realtime',
    openaiModel: 'gpt-realtime-mini',
    hotkey: 'Control+Shift+Space',
    claudeHost: 'auto',
    wakeWordEnabled: false,
    screenAwareness: false,
  },
});

/** Keys that must never be pushed as plaintext (secrets live in safeStorage). */
const CONFIG_KEYS: Array<keyof AppConfig> = [
  'assistantName',
  'personality',
  'voiceProvider',
  'openaiModel',
  'hotkey',
  'claudeHost',
  'wakeWordEnabled',
  'screenAwareness',
  'userName',
  'characterCard',
];

/** Push the whole persisted config to the daemon so its ConfigStore reflects it. */
function pushConfigToDaemon(): void {
  for (const key of CONFIG_KEYS) {
    const value = config.get(key);
    if (value !== undefined) daemonClient?.send('config.set', { key: String(key), value });
  }
}

let supervisor: DaemonSupervisor | undefined;
let connection: DaemonConnection | undefined;
let daemonClient: DaemonClient | undefined;
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

  // Main connects to the daemon as role 'main' to service screen-capture requests
  // (screenshots + foreground window title happen here, even if the daemon is in WSL).
  daemonClient = new DaemonClient(connection);
  daemonClient.on('screen.capture_request', (env) => {
    void captureScreen(env.payload).then((result) => {
      daemonClient?.send('screen.capture_result', result, { replyTo: env.id });
    });
  });
  // On (re)connect the daemon starts from defaults — push our persisted config.
  daemonClient.on('welcome', () => pushConfigToDaemon());
  daemonClient.connect();

  registerIpc({
    resolve: (win) => {
      if (!connection) return undefined;
      const role = win === overlay ? 'overlay' : 'chat';
      return { connection, role };
    },
    getModel: () => config.get('openaiModel'),
    // Settings: read the persisted config (secrets excluded).
    getConfig: () => {
      const out: Record<string, unknown> = {};
      for (const key of CONFIG_KEYS) out[String(key)] = config.get(key);
      return out;
    },
    // Persist a config change and forward it to the daemon (live reload).
    setConfig: (key, value) => {
      config.set(key, value as AppConfig[keyof AppConfig]);
      daemonClient?.send('config.set', { key, value });
      if (key === 'hotkey' && typeof value === 'string') registerHotkey(value);
    },
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

  registerHotkey(config.get('hotkey'));
}

/** (Re)register the push-to-talk global shortcut, replacing any prior binding. */
function registerHotkey(accelerator: string): void {
  globalShortcut.unregisterAll();
  try {
    globalShortcut.register(accelerator, () => {
      // Signal the overlay to toggle the voice session. (Chat opens from the tray
      // or by clicking the avatar.)
      overlay?.webContents.send('wk:push-to-talk');
    });
  } catch (err) {
    process.stderr.write(`[workerking] failed to register hotkey "${accelerator}": ${String(err)}\n`);
  }
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
  daemonClient?.close();
  supervisor?.stop();
});

// Keep running in the tray when all windows are closed.
app.on('window-all-closed', () => {
  if (quitting && process.platform !== 'darwin') app.quit();
});
