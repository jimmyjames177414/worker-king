import { homedir } from 'node:os';
import { join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { CapabilityManifest } from '@workerking/shared';
import { buildCapabilityManifest, type CapabilityQueryFn } from './CapabilityManifest.js';

/**
 * CapabilityManager — owns the live capability manifest.
 *
 * Builds it once at start, rebuilds (debounced) whenever the user's skill/agent
 * directories change, and hands each new snapshot to `broadcast` (the daemon
 * broadcasts it as `capability.updated`). Claude Code hot-reloads skills within a
 * session, so the file watch keeps the voice layer's routing summary fresh.
 */
export interface CapabilityManagerOptions {
  queryFn: CapabilityQueryFn;
  sdkOptions?: Options;
  broadcast: (manifest: CapabilityManifest) => void;
  now?: () => number;
  /** Dirs to watch; defaults to user + project skills/agents. */
  watchDirs?: string[];
  debounceMs?: number;
  cwd?: string;
}

export function defaultWatchDirs(cwd = process.cwd()): string[] {
  const home = homedir();
  return [
    join(home, '.claude', 'skills'),
    join(home, '.claude', 'agents'),
    join(home, '.claude', 'commands'),
    join(cwd, '.claude', 'skills'),
    join(cwd, '.claude', 'agents'),
    join(cwd, '.claude', 'commands'),
  ];
}

export class CapabilityManager {
  private version = 0;
  private manifest?: CapabilityManifest;
  private watcher?: FSWatcher;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly watchDirs: string[];

  constructor(private readonly opts: CapabilityManagerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.debounceMs = opts.debounceMs ?? 800;
    this.watchDirs = opts.watchDirs ?? defaultWatchDirs(opts.cwd);
  }

  getManifest(): CapabilityManifest | undefined {
    return this.manifest;
  }

  /** Build the first snapshot and start watching for changes. */
  async start(): Promise<void> {
    await this.refresh();
    this.setupWatch();
  }

  async refresh(): Promise<CapabilityManifest> {
    this.version += 1;
    const manifest = await buildCapabilityManifest({
      queryFn: this.opts.queryFn,
      options: this.opts.sdkOptions,
      version: this.version,
      now: this.now,
    });
    this.manifest = manifest;
    this.opts.broadcast(manifest);
    return manifest;
  }

  private setupWatch(): void {
    // chokidar tolerates non-existent paths and picks them up if created later.
    this.watcher = chokidar.watch(this.watchDirs, { ignoreInitial: true });
    const onChange = () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => void this.refresh().catch(() => {}), this.debounceMs);
    };
    this.watcher.on('add', onChange);
    this.watcher.on('change', onChange);
    this.watcher.on('unlink', onChange);
    this.watcher.on('addDir', onChange);
    this.watcher.on('unlinkDir', onChange);
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    await this.watcher?.close();
    this.watcher = undefined;
  }
}
