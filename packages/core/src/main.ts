import { writeFileSync } from 'node:fs';
import { WsServer } from './ws/server.js';
import { ConfigStore } from './config/ConfigStore.js';
import { Supervisor } from './supervisor/Supervisor.js';
import { EchoBrain } from './brain/Brain.js';
import { detectHost } from './util/host.js';
import { newToken } from './util/ids.js';

export const DAEMON_VERSION = '0.0.0';

export interface StartDaemonOptions {
  port?: number;
  token?: string;
  /** Where to write the handshake file (port + token) for the Electron app. */
  handshakeFile?: string;
  brain?: EchoBrain;
}

export interface RunningDaemon {
  port: number;
  token: string;
  server: WsServer;
  stop: () => Promise<void>;
}

/**
 * Boot the core daemon: WS server + config + supervisor + brain.
 * Returns the bound port and auth token. Callers (Electron main, or a test)
 * decide how to surface those to clients.
 */
export async function startDaemon(opts: StartDaemonOptions = {}): Promise<RunningDaemon> {
  const token = opts.token ?? process.env.WORKERKING_TOKEN ?? newToken();
  const host = detectHost();

  const config = new ConfigStore();
  const server = new WsServer({ token, host, daemonVersion: DAEMON_VERSION });
  const brain = opts.brain ?? new EchoBrain();
  new Supervisor(server, config, brain);

  const requestedPort =
    opts.port ?? (process.env.WORKERKING_PORT ? Number(process.env.WORKERKING_PORT) : 0);
  const port = await server.start(requestedPort);

  const handshake = { port, token, pid: process.pid, host, daemonVersion: DAEMON_VERSION };
  const handshakeFile = opts.handshakeFile ?? process.env.WORKERKING_HANDSHAKE_FILE;
  if (handshakeFile) {
    writeFileSync(handshakeFile, JSON.stringify(handshake, null, 2), 'utf8');
  }
  // Machine-readable line so a parent process can capture the port without a file.
  process.stdout.write(`WORKERKING_READY ${JSON.stringify(handshake)}\n`);

  return {
    port,
    token,
    server,
    stop: async () => {
      await server.close();
    },
  };
}

// Run directly (node src/main.ts / node dist/main.js) — but not when imported by tests.
const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('main.ts') || process.argv[1].endsWith('main.js'));

if (isDirectRun) {
  startDaemon()
    .then((d) => {
      process.stderr.write(`[workerking] daemon listening on 127.0.0.1:${d.port}\n`);
      const shutdown = () => {
        d.stop().finally(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      process.stderr.write(`[workerking] daemon failed to start: ${String(err)}\n`);
      process.exit(1);
    });
}
