import { app, globalShortcut, BrowserWindow, powerMonitor, Notification, clipboard } from 'electron';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Store from 'electron-store';
import { DEFAULT_CONFIG, CONFIG_KEYS, type WorkerKingConfig } from '@workerking/shared';

// Tee stderr to a log file so the F5 debugger session is visible to Claude.
if (process.env['WORKERKING_APP_LOG']) {
  const logPath = process.env['WORKERKING_APP_LOG'];
  mkdirSync(dirname(logPath), { recursive: true });
  const logStream = createWriteStream(logPath, { flags: 'a' });
  const origWrite = process.stderr.write.bind(process.stderr);
  // Tee writes to the log file, then delegate to the original stderr.write.
  process.stderr.write = (chunk: unknown, ...args: unknown[]) => {
    logStream.write(String(chunk));
    return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args);
  };
}
import { DaemonSupervisor, type DaemonConnection } from './DaemonSupervisor.js';
import { detectClaude } from './WslDetector.js';
import { createOverlayWindow } from './windows/OverlayWindow.js';
import { createChatWindow, toggleChatWindow } from './windows/ChatWindow.js';
import { createTray } from './TrayController.js';
import { registerIpc } from './ipc.js';
import { DaemonClient } from './DaemonClient.js';
import { captureScreen } from './ScreenCapture.js';
import { HotkeyManager } from './HotkeyManager.js';

/**
 * WorkerKing Electron main. Phase 0 wiring:
 *  1. Read config (hotkey, claudeHost).
 *  2. Decide where Claude lives (auto = probe Windows then WSL).
 *  3. Spawn + supervise the core daemon; learn its port + token.
 *  4. Create the overlay + chat windows; register click-through, tray, hotkey.
 *  5. Renderers fetch their connection over IPC and open their own WS.
 */

// The persisted, user-editable config. Main owns this file (electron-store); the
// daemon receives a copy over WS on connect and on every change. The config
// *shape* (schema, defaults, key list) is defined once in @workerking/shared so
// this side can never drift from the daemon's ConfigStore.
const config = new Store<WorkerKingConfig>({
  name: 'config',
  defaults: DEFAULT_CONFIG,
});

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

// Pending explain-hotkey requests, keyed by messageId → callback with the reply.
const pendingExplain = new Map<string, (text: string) => void>();

// Global shortcuts (push-to-talk + explain-selection), created at boot.
const hotkeys = new HotkeyManager(globalShortcut, {
  pushToTalk: () => overlay?.webContents.send('wk:push-to-talk'),
  explain: () => explainSelection(),
});
/** Bind push-to-talk, warning if the accelerator is already taken. */
function registerHotkey(accelerator: string): void {
  if (!hotkeys.setPushToTalk(accelerator)) {
    process.stderr.write(`[workerking] failed to register hotkey "${accelerator}" (already taken)\n`);
  }
}
/** Bind the explain-selection shortcut, warning if taken. */
function registerExplainHotkey(accelerator: string): void {
  if (!hotkeys.setExplain(accelerator)) {
    process.stderr.write(`[workerking] failed to register explain hotkey "${accelerator}" (already taken)\n`);
  }
}

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
    process.stderr.write(`[daemon] crashed (code ${code})\n`),
  );
  supervisor.on('backoff', ({ attempt, delayMs }: { attempt: number; delayMs: number }) =>
    process.stderr.write(`[daemon] restart attempt ${attempt} in ${delayMs}ms\n`),
  );
  supervisor.on('restarted', (conn: DaemonConnection) => {
    connection = conn;
  });
  // Crash-loop budget exhausted: stop thrashing and tell the user.
  supervisor.on('fatal', (err: Error) => {
    process.stderr.write(`[daemon] fatal: ${err.message}\n`);
    if (Notification.isSupported()) {
      new Notification({
        title: config.get('assistantName') || 'WorkerKing',
        body: 'The assistant daemon keeps crashing and has stopped. Check the logs.',
      }).show();
    }
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
  // Proactive notices → Windows toast (the overlay speaks them separately over WS).
  daemonClient.on('proactive.notify', (env) => {
    if (Notification.isSupported()) {
      new Notification({ title: config.get('assistantName') || 'WorkerKing', body: env.payload.text }).show();
    }
  });
  // Explain-hotkey replies (chat.assistant_done matched by messageId) → toast + speak.
  daemonClient.on('chat.assistant_done', (env) => {
    const cb = pendingExplain.get(env.payload.messageId ?? '');
    if (cb) {
      pendingExplain.delete(env.payload.messageId ?? '');
      cb(env.payload.text);
    }
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
      config.set(key, value as WorkerKingConfig[keyof WorkerKingConfig]);
      daemonClient?.send('config.set', { key, value });
      if (key === 'hotkey' && typeof value === 'string') registerHotkey(value);
      if (key === 'explainHotkey' && typeof value === 'string') registerExplainHotkey(value);
    },
    // Right-click on the avatar surfaces the chat window.
    onOpenChat: () => {
      if (chat) {
        chat.show();
        chat.focus();
      }
    },
  });

  overlay = createOverlayWindow();
  chat = createChatWindow();

  // Forward renderer console output to main stderr so the log runner captures it.
  for (const [label, win] of [['overlay', overlay], ['chat', chat]] as const) {
    win.webContents.on('console-message', (_e, _level, msg) => {
      process.stderr.write(`[renderer:${label}] ${msg}\n`);
    });
  }

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
  registerExplainHotkey(config.get('explainHotkey'));

  // After sleep, WSL2's localhost forwarding (and sometimes native sockets) can
  // drop. Proactively heal: reconnect main's daemon client, re-push config, and
  // tell the renderers to reconnect their WS clients.
  powerMonitor.on('resume', () => {
    process.stderr.write('[workerking] system resumed — reconnecting daemon links\n');
    daemonClient?.reconnect(); // guarded: no-op if the socket is still healthy
    overlay?.webContents.send('wk:reconnect');
    chat?.webContents.send('wk:reconnect');
  });
}

/** Read the clipboard selection, ask Claude to explain/act on it, speak + toast the reply. */
function explainSelection(): void {
  const text = clipboard.readText().trim();
  if (!text) {
    if (Notification.isSupported()) {
      new Notification({ title: 'WorkerKing', body: 'Select or copy some text first, then press the hotkey.' }).show();
    }
    return;
  }
  const messageId = randomUUID();
  // Drop the pending entry if no reply arrives (e.g. the daemon returned `error`)
  // so the map + its captured closures don't leak over a long session.
  const timeout = setTimeout(() => pendingExplain.delete(messageId), 90_000);
  pendingExplain.set(messageId, (reply) => {
    clearTimeout(timeout);
    if (Notification.isSupported()) new Notification({ title: 'WorkerKing', body: reply }).show();
    overlay?.webContents.send('wk:speak', reply); // the overlay speaks it (chat has no speak handler)
  });
  daemonClient?.send('chat.user_message', {
    text: `The user selected this text and wants your help with it — explain it or act on it, concisely:\n\n${text}`,
    messageId,
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
  hotkeys.unregisterAll();
  daemonClient?.close();
  supervisor?.stop();
});

// Keep running in the tray when all windows are closed.
app.on('window-all-closed', () => {
  if (quitting && process.platform !== 'darwin') app.quit();
});
