import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

export interface DaemonConnection {
  port: number;
  token: string;
  host: 'windows' | 'wsl' | 'unknown';
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface DaemonSupervisorOptions {
  /** 'windows' spawns node natively; 'wsl' spawns via wsl.exe. */
  mode: 'windows' | 'wsl';
  /** WSL distro name (mode 'wsl' only). */
  wslDistro?: string;
  /** Max crash-restarts allowed within `restartWindowMs` before giving up. Default 5. */
  maxRestarts?: number;
  /** Rolling window over which restarts are counted. Default 60_000ms. */
  restartWindowMs?: number;
  /** First backoff delay; doubles each consecutive restart. Default 500ms. */
  backoffBaseMs?: number;
  /** Backoff ceiling. Default 30_000ms. */
  backoffMaxMs?: number;
  /** Uptime after which a run is "healthy" and the restart counter resets. Default 30_000ms. */
  healthyUptimeMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable delay (tests). */
  delayFn?: (ms: number) => Promise<void>;
  /** Injectable spawn (tests). */
  spawnFn?: SpawnFn;
  /**
   * Path the daemon should write its handshake JSON to. External processes
   * (e.g. Sprint's notify.js) read this file to learn the per-boot port + token.
   * Defaults to `.workerking-handshake.json` in the repo root (dev builds).
   */
  handshakeFile?: string;
}

/**
 * Spawns and supervises the core daemon (@workerking/core). Captures the
 * `WORKERKING_READY {json}` handshake line from stdout to learn the bound port
 * and auth token, then keeps the process alive across crashes.
 *
 * Crash handling is bounded: each restart waits an exponential backoff, and if
 * the daemon crashes more than `maxRestarts` times within `restartWindowMs` the
 * supervisor gives up and emits `fatal` instead of hot-looping spawns forever. A
 * run that stays up past `healthyUptimeMs` resets the counter, so an occasional
 * crash after a long healthy session doesn't count toward the loop budget.
 *
 * Native mode runs `node <coreMain>`. WSL mode runs
 * `wsl.exe -d <distro> -e node <linuxPathToCoreMain>` — the same daemon reached
 * over automatic localhost forwarding, so the rest of the app is identical.
 *
 * Events: `ready`, `restarted`, `crash`, `backoff` ({attempt, delayMs}),
 * `fatal` (Error — gave up), `log`, `error`, `exit`.
 */
export class DaemonSupervisor extends EventEmitter {
  private child?: ChildProcess;
  private connection?: DaemonConnection;
  private stopping = false;

  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly healthyUptimeMs: number;
  private readonly now: () => number;
  private readonly delayFn: (ms: number) => Promise<void>;
  private readonly spawnFn: SpawnFn;

  /** Timestamps of recent crash-restarts, pruned to `restartWindowMs`. */
  private restartTimestamps: number[] = [];
  /** When the current run reported READY (undefined until ready / after a crash). */
  private readyAt?: number;

  constructor(private readonly opts: DaemonSupervisorOptions) {
    super();
    this.maxRestarts = opts.maxRestarts ?? 5;
    this.restartWindowMs = opts.restartWindowMs ?? 60_000;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000;
    this.healthyUptimeMs = opts.healthyUptimeMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.delayFn = opts.delayFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.spawnFn = opts.spawnFn ?? spawn;
  }

  /** Start the daemon and resolve once it reports READY. */
  start(): Promise<DaemonConnection> {
    const token = randomUUID().replace(/-/g, '');
    const coreMain = require.resolve('@workerking/core');

    // Derive handshake file path: explicit option > env override > repo-root default.
    // External processes (Sprint notify.js) read this file to learn the port + token.
    const handshakeFile =
      this.opts.handshakeFile ??
      process.env['WORKERKING_HANDSHAKE_FILE'] ??
      resolve(dirname(coreMain), '../../../.workerking-handshake.json');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WORKERKING_TOKEN: token,
      WORKERKING_PORT: '0',
      WORKERKING_HANDSHAKE_FILE: handshakeFile,
    };

    let command: string;
    let args: string[];
    if (this.opts.mode === 'wsl') {
      const linuxPath = toWslPath(coreMain);
      command = 'wsl.exe';
      args = [...(this.opts.wslDistro ? ['-d', this.opts.wslDistro] : []), '-e', 'node', linuxPath];
    } else {
      command = process.execPath; // Electron's bundled node in the main process
      args = [coreMain];
      // Ensure the child runs as plain Node, not a second Electron instance.
      env.ELECTRON_RUN_AS_NODE = '1';
    }

    return new Promise((resolve, reject) => {
      const child = this.spawnFn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
              if (this.readyAt === undefined) this.readyAt = this.now();
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
          // Crash after ready → bounded restart with backoff + crash-loop guard.
          this.emit('crash', code);
          void this.handleCrash();
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

  /**
   * Decide whether to restart after a crash, and do it with backoff. Gives up
   * (emits `fatal`) once crashes exceed the budget within the rolling window.
   */
  private async handleCrash(): Promise<void> {
    const t = this.now();

    // A run that stayed up past the healthy threshold clears the loop counter —
    // one crash after a long healthy session shouldn't count toward the budget.
    if (this.readyAt !== undefined && t - this.readyAt >= this.healthyUptimeMs) {
      this.restartTimestamps = [];
    }
    this.readyAt = undefined;

    // Drop restarts that fell out of the rolling window.
    this.restartTimestamps = this.restartTimestamps.filter((ts) => t - ts < this.restartWindowMs);

    if (this.restartTimestamps.length >= this.maxRestarts) {
      const secs = Math.round(this.restartWindowMs / 1000);
      this.emit(
        'fatal',
        new Error(
          `daemon crashed ${this.restartTimestamps.length + 1} times within ${secs}s; giving up`,
        ),
      );
      return;
    }

    const attempt = this.restartTimestamps.length; // 0-based → backoff exponent
    this.restartTimestamps.push(t);
    const delayMs = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** attempt);
    this.emit('backoff', { attempt: attempt + 1, delayMs });

    await this.delayFn(delayMs);
    if (this.stopping) return;

    try {
      this.child = undefined;
      const conn = await this.start();
      this.emit('restarted', conn);
    } catch (err) {
      // Restart never reached READY — count it and keep the backoff loop going.
      this.emit('error', err);
      void this.handleCrash();
    }
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
