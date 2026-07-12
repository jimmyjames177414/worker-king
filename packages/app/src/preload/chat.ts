import { contextBridge, ipcRenderer } from 'electron';
import type { WorkerKingConnection } from './overlay.js';

/** Chat preload. Exposes only the connection resolver; chat traffic is WS. */
const api = {
  getConnection: (): Promise<WorkerKingConnection | undefined> =>
    ipcRenderer.invoke('wk:get-connection'),
};

contextBridge.exposeInMainWorld('workerking', api);

export type WorkerKingChatApi = typeof api;
