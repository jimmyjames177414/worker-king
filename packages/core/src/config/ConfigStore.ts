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
  /** Allow scheduled reminders; on by default. */
  remindersEnabled: boolean;
  /** Run scheduled proactive "watch" checks (spends Claude quota); off by default. */
  proactiveEnabled: boolean;
  /** Global hotkey to explain/act on the current clipboard selection. */
  explainHotkey: string;
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
  remindersEnabled: true,
  proactiveEnabled: false,
  explainHotkey: 'Control+Shift+E',
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
