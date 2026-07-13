import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);

export interface DaemonConnection {
  port: number;
  token: string;
  host: 'windows' | 'wsl' | 'unknown';
}

export interface DaemonSupervisorOptions {
  /** 'windows' spawns node natively; 'wsl' spawns via wsl.exe. */
  mode: 'windows' | 'wsl';
  /** WSL distro name (mode 'wsl' only). */
  wslDistro?: string;
}

/**
 * Spawns and supervises the core daemon (@workerking/core). Captures the
 * `WORKERKING_READY {json}` handshake line from stdout to learn the bound port
 * and auth token, then keeps the process alive (restart on crash).
 *
 * Native mode runs `node <coreMain>`. WSL mode runs
 * `wsl.exe -d <distro> -e node <linuxPathToCoreMain>` — the same daemon reached
 * over automatic localhost forwarding, so the rest of the app is identical.
 */
export class DaemonSupervisor extends EventEmitter {
  private child?: ChildProcess;
  private connection?: DaemonConnection;
  private stopping = false;

  constructor(private readonly opts: DaemonSupervisorOptions) {
    super();
  }

  /** Start the daemon and resolve once it reports READY. */
  start(): Promise<DaemonConnection> {
    const token = randomUUID().replace(/-/g, '');
    const coreMain = require.resolve('@workerking/core');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WORKERKING_TOKEN: token,
      WORKERKING_PORT: '0',
    };

    let command: string;
    let args: string[];
    if (this.opts.mode === 'wsl') {
      const linuxPath = toWslPath(coreMain);
      command = 'wsl.exe';
      args = [
        ...(this.opts.wslDistro ? ['-d', this.opts.wslDistro] : []),
        '-e',
        'node',
        linuxPath,
      ];
    } else {
      command = process.execPath; // Electron's bundled node in the main process
      args = [coreMain];
      // Ensure the child runs as plain Node, not a second Electron instance.
      env.ELECTRON_RUN_AS_NODE = '1';
    }

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;

      let settled = false;
      let stdoutBuf = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        let idx: number;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (line.startsWith('WORKERKING_READY ')) {
            try {
              const info = JSON.parse(line.slice('WORKERKING_READY '.length));
              this.connection = { port: info.port, token: info.token, host: info.host };
              if (!settled) {
                settled = true;
                resolve(this.connection);
              }
              this.emit('ready', this.connection);
            } catch {
              // ignore malformed line
            }
          }
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        this.emit('log', chunk.toString());
      });

      child.on('exit', (code) => {
        this.emit('exit', code);
        if (!settled) {
          settled = true;
          reject(new Error(`daemon exited before ready (code ${code})`));
        } else if (!this.stopping) {
          // Crash after ready → attempt one restart.
          this.emit('crash', code);
          this.restart().catch((err) => this.emit('error', err));
        }
      });

      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        } else {
          this.emit('error', err);
        }
      });
    });
  }

  private async restart(): Promise<void> {
    this.child = undefined;
    const conn = await this.start();
    this.emit('restarted', conn);
  }

  getConnection(): DaemonConnection | undefined {
    return this.connection;
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill();
    this.child = undefined;
  }
}

/** Convert a Windows path (C:\a\b) to a WSL path (/mnt/c/a/b). */
export function toWslPath(winPath: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return winPath.replace(/\\/g, '/');
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, '/');
  return `/mnt/${drive}/${rest}`;
}
