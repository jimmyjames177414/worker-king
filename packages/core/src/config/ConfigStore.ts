import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
 */

export interface WorkerKingConfig {
  assistantName: string;
  personality: string;
  /** Active voice provider id. */
  voiceProvider: 'gpt-realtime' | 'local-cascade';
  /** OpenAI Realtime model for the voice layer. */
  openaiModel: string;
  /** Where the Claude backend runs. 'auto' probes Windows then WSL. */
  claudeHost: 'auto' | 'windows' | 'wsl';
  /** Working directory for the Claude Agent SDK session. */
  claudeCwd?: string;
  /** Push-to-talk global shortcut accelerator. */
  hotkey: string;
  /** Always-listening wake word ("Hey <name>"); off by default (hotkey-first). */
  wakeWordEnabled: boolean;
  /** Allow Claude to read the foreground window / screenshots; off by default. */
  screenAwareness: boolean;
  /** Persist durable facts/preferences across sessions; on by default. */
  memoryEnabled: boolean;
  /** Use local-embedding semantic recall (falls back to keyword if unavailable); off by default. */
  semanticMemory: boolean;
  /** Allow scheduled reminders; on by default. */
  remindersEnabled: boolean;
  /** Run scheduled proactive "watch" checks (spends Claude quota); off by default. */
  proactiveEnabled: boolean;
  /** Global hotkey to explain/act on the current clipboard selection. */
  explainHotkey: string;
  /** Preferred microphone deviceId (empty/undefined = system default). */
  inputDeviceId?: string;
  /** Preferred audio-output deviceId (empty/undefined = system default). */
  outputDeviceId?: string;
  /** The user's display name, for {{user}} in character cards. */
  userName?: string;
  /** Active SillyTavern chara_card_v2 (object), if the user imported one. */
  characterCard?: unknown;
  [key: string]: unknown;
}

export const DEFAULT_CONFIG: WorkerKingConfig = {
  assistantName: 'WorkerKing',
  personality:
    'A capable, upbeat desktop companion. Concise out loud, thorough when it matters. ' +
    'Delegates real work to Claude Code and narrates progress plainly.',
  voiceProvider: 'gpt-realtime',
  openaiModel: 'gpt-realtime-mini',
  claudeHost: 'auto',
  hotkey: 'Control+Shift+Space',
  wakeWordEnabled: false,
  screenAwareness: false,
  memoryEnabled: true,
  semanticMemory: false,
  remindersEnabled: true,
  proactiveEnabled: false,
  explainHotkey: 'Control+Shift+E',
};

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
      return parsed && typeof parsed === 'object' ? parsed : {};
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
