import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, parseConfig, type WorkerKingConfig } from '@workerking/shared';

/**
 * ConfigStore — the daemon's view of user configuration.
 *
 * In the full app, Electron main owns the electron-store file (ajv schema +
 * onDidChange) and proxies it to the daemon over WS (`config.get`/`set`/
 * `changed`). For headless runs (`pnpm daemon`) there is no Electron to re-push
 * config, so the store can optionally back itself with a JSON file (mirroring
 * MemoryStore) — otherwise a standalone daemon would forget everything, including
 * an imported character card, on every restart. Persistence is opt-in so tests
 * and the app-proxied path stay in-memory.
 *
 * The config *shape* (schema, defaults) lives in `@workerking/shared` so the app
 * and daemon share one definition; this module only owns persistence + change
 * notification.
 */

export { DEFAULT_CONFIG, type WorkerKingConfig } from '@workerking/shared';

export type ConfigChangeListener = (key: string, value: unknown) => void;

export interface ConfigStoreOptions {
  /** Persist to / load from a JSON file so config survives a headless restart. */
  persist?: boolean;
  /** Directory for the config file. Defaults to ~/.claude/workerking. */
  dir?: string;
}

export class ConfigStore {
  private data: WorkerKingConfig;
  private readonly listeners = new Set<ConfigChangeListener>();
  private readonly persistPath?: string;

  constructor(initial?: Partial<WorkerKingConfig>, opts: ConfigStoreOptions = {}) {
    const dir = opts.dir ?? join(homedir(), '.claude', 'workerking');
    this.persistPath = opts.persist ? join(dir, 'config.json') : undefined;
    // defaults < persisted file < explicit initial overrides.
    this.data = { ...DEFAULT_CONFIG, ...this.load(), ...initial };
  }

  private load(): Partial<WorkerKingConfig> {
    if (!this.persistPath || !existsSync(this.persistPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.persistPath, 'utf8'));
      // Validate against the shared schema: well-typed keys are kept, bad ones
      // dropped, so a corrupt/tampered field can't poison the daemon's config.
      return parseConfig(parsed);
    } catch {
      // Corrupt file → fall back to defaults; the next write repairs it.
      return {};
    }
  }

  private persist(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(join(this.persistPath, '..'), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      // Persistence is best-effort; never let it break the daemon.
    }
  }

  get<K extends keyof WorkerKingConfig>(key: K): WorkerKingConfig[K];
  get(): WorkerKingConfig;
  get(key?: string): unknown {
    if (key === undefined) return { ...this.data };
    return this.data[key];
  }

  set(key: string, value: unknown): void {
    this.data[key] = value;
    this.persist();
    for (const l of this.listeners) l(key, value);
  }

  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
