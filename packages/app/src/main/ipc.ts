import { ipcMain, BrowserWindow } from 'electron';
import type { DaemonConnection } from './DaemonSupervisor.js';
import type { WsRole } from '@workerking/shared';

/**
 * The minimal IPC surface. Renderers ask main for their daemon connection info
 * (port + token + role) so they can open their own WS connection to the daemon.
 * Everything else (chat, tasks, voice, config) flows over WS, not IPC.
 */
export interface ConnectionResolver {
  (window: BrowserWindow): { connection: DaemonConnection; role: WsRole } | undefined;
}

export function registerIpc(resolve: ConnectionResolver): void {
  ipcMain.handle('wk:get-connection', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return undefined;
    const resolved = resolve(win);
    if (!resolved) return undefined;
    return {
      port: resolved.connection.port,
      token: resolved.connection.token,
      host: resolved.connection.host,
      role: resolved.role,
    };
  });
}
