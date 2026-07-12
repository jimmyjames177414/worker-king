import { ipcMain, BrowserWindow } from 'electron';
import type { DaemonConnection } from './DaemonSupervisor.js';
import type { WsRole } from '@workerking/shared';
import { mintEphemeralKey } from './RealtimeKeys.js';
import { getSecret } from './Secrets.js';

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

  // Mint an ephemeral Realtime key. The real key never leaves main.
  ipcMain.handle('wk:mint-realtime-key', async () => {
    const apiKey = getSecret('openai') ?? '';
    return mintEphemeralKey(apiKey, deps.getModel());
  });
}
