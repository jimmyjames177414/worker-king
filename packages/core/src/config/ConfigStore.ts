/**
 * ConfigStore — the daemon's view of user configuration.
 *
 * In the full app, Electron main owns the electron-store file (ajv schema +
 * onDidChange) and proxies it to the daemon over WS (`config.get`/`set`/
 * `changed`). For Phase 0 (and for headless runs of the daemon), this is a
 * simple in-memory store seeded with defaults. The interface is stable so the
 * proxy can be dropped in later without touching call sites.
 */

export interface WorkerKingConfig {
  assistantName: string;
  personality: string;
  /** Active voice provider id. */
  voiceProvider: 'gpt-realtime' | 'local-cascade';
  /** Where the Claude backend runs. 'auto' probes Windows then WSL. */
  claudeHost: 'auto' | 'windows' | 'wsl';
  /** Working directory for the Claude Agent SDK session. */
  claudeCwd?: string;
  /** Push-to-talk global shortcut accelerator. */
  hotkey: string;
  [key: string]: unknown;
}

export const DEFAULT_CONFIG: WorkerKingConfig = {
  assistantName: 'WorkerKing',
  personality:
    'A capable, upbeat desktop companion. Concise out loud, thorough when it matters. ' +
    'Delegates real work to Claude Code and narrates progress plainly.',
  voiceProvider: 'gpt-realtime',
  claudeHost: 'auto',
  hotkey: 'Control+Shift+Space',
};

export type ConfigChangeListener = (key: string, value: unknown) => void;

export class ConfigStore {
  private data: WorkerKingConfig;
  private readonly listeners = new Set<ConfigChangeListener>();

  constructor(initial?: Partial<WorkerKingConfig>) {
    this.data = { ...DEFAULT_CONFIG, ...initial };
  }

  get<K extends keyof WorkerKingConfig>(key: K): WorkerKingConfig[K];
  get(): WorkerKingConfig;
  get(key?: string): unknown {
    if (key === undefined) return { ...this.data };
    return this.data[key];
  }

  set(key: string, value: unknown): void {
    this.data[key] = value;
    for (const l of this.listeners) l(key, value);
  }

  onChange(listener: ConfigChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
