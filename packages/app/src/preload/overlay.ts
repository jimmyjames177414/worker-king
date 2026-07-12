import { contextBridge, ipcRenderer } from 'electron';

/**
 * Overlay preload. Exposes a tiny, typed bridge:
 *  - getConnection(): the daemon port + token + role, so the renderer opens its
 *    own WS to the daemon.
 *  - setClickThrough(on): tell main to make the overlay click-through or solid
 *    (called on avatar hover enter/leave).
 */
export interface WorkerKingConnection {
  port: number;
  token: string;
  host: 'windows' | 'wsl' | 'unknown';
  role: 'overlay' | 'chat';
}

const api = {
  getConnection: (): Promise<WorkerKingConnection | undefined> =>
    ipcRenderer.invoke('wk:get-connection'),
  setClickThrough: (on: boolean): void => ipcRenderer.send('wk:set-click-through', on),
};

contextBridge.exposeInMainWorld('workerking', api);

export type WorkerKingOverlayApi = typeof api;
