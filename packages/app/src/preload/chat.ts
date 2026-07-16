import { contextBridge, ipcRenderer } from 'electron';
import type { WorkerKingConnection } from './overlay.js';

/**
 * Chat preload. Exposes the daemon connection (chat traffic is WS) plus the
 * settings surface: config read/write, write-only secret storage, and a
 * has-secret check for UI state.
 */
const api = {
  getConnection: (): Promise<WorkerKingConnection | undefined> =>
    ipcRenderer.invoke('wk:get-connection'),
  getConfig: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('wk:get-config'),
  setConfig: (key: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke('wk:set-config', key, value),
  setSecret: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke('wk:set-secret', key, value),
  hasSecret: (key: string): Promise<boolean> => ipcRenderer.invoke('wk:has-secret', key),
  /** Show + focus this window (a confirm prompt in a hidden window is invisible). */
  showWindow: (): void => {
    ipcRenderer.send('wk:open-chat');
  },
  /** Fired after system resume so the renderer can heal its WS connection. */
  onReconnect: (cb: () => void): void => {
    ipcRenderer.on('wk:reconnect', () => cb());
  },
};

contextBridge.exposeInMainWorld('workerking', api);

export type WorkerKingChatApi = typeof api;
