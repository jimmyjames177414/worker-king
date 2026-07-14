import { ipcMain, BrowserWindow } from 'electron';
import type { DaemonConnection } from './DaemonSupervisor.js';
import type { WsRole } from '@workerking/shared';
import { mintEphemeralKey } from './RealtimeKeys.js';
import { getSecret, setSecret, hasSecret } from './Secrets.js';

/**
 * The minimal IPC surface. Renderers ask main for their daemon connection info
 * (port + token + role) so they can open their own WS connection to the daemon.
 * Everything else (chat, tasks, voice, config) flows over WS, not IPC.
 */
export interface ConnectionResolver {
  (window: BrowserWindow): { connection: DaemonConnection; role: WsRole } | undefined;
}

export interface IpcDeps {
  resolve: ConnectionResolver;
  /** Read the current OpenAI Realtime model from config. */
  getModel: () => string;
  /** Read the persisted config (secrets excluded). */
  getConfig: () => Record<string, unknown>;
  /** Persist a config change + forward it to the daemon. */
  setConfig: (key: string, value: unknown) => void;
}

export function registerIpc(deps: IpcDeps): void {
  ipcMain.handle('wk:get-connection', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return undefined;
    const resolved = deps.resolve(win);
    if (!resolved) return undefined;
    return {
      port: resolved.connection.port,
      token: resolved.connection.token,
      host: resolved.connection.host,
      role: resolved.role,
    };
  });

  // Mint an ephemeral Realtime key. Stored secret takes precedence; env var is
  // the dev fallback so you can test without going through the settings UI.
  ipcMain.handle('wk:mint-realtime-key', async () => {
    const apiKey = getSecret('openai') ?? process.env['OPENAI_API_KEY'] ?? '';
    return mintEphemeralKey(apiKey, deps.getModel());
  });

  // Settings: config read/write (write is persisted + forwarded to the daemon).
  ipcMain.handle('wk:get-config', () => deps.getConfig());
  ipcMain.handle('wk:set-config', (_e, key: string, value: unknown) => {
    deps.setConfig(key, value);
  });

  // Secrets: write-only from the renderer (never read back); has-check for UI state.
  ipcMain.handle('wk:set-secret', (_e, key: string, value: string) => {
    setSecret(key, value);
  });
  ipcMain.handle('wk:has-secret', (_e, key: string) => hasSecret(key));
}
