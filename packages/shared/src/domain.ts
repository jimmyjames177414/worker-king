import { z } from 'zod';

/**
 * Domain types shared across every WorkerKing process.
 *
 * These are the nouns of the system: Tasks that Claude Code runs, the capability
 * manifest that tells the voice layer what WorkerKing can do, and the config that
 * defines its name/personality/voice.
 *
 * Everything is a zod schema so it can be validated at process boundaries; the
 * inferred TypeScript type is exported alongside each schema.
 */

// ---------------------------------------------------------------------------
// Tasks — a unit of delegated work handed to Claude Code.
// ---------------------------------------------------------------------------

export const taskStateSchema = z.enum([
  'queued',
  'running',
  'awaiting_permission',
  'done',
  'error',
  'cancelled',
]);
export type TaskState = z.infer<typeof taskStateSchema>;

export const taskProgressSchema = z.object({
  ts: z.number(),
  /** Coarse phase of the underlying Claude Code turn, for avatar + phrasing. */
  phase: z.enum(['planning', 'tool', 'writing', 'summary']),
  /** Already-summarized, voice-friendly text. */
  text: z.string(),
  /** Whether this progress item has been spoken to the user yet. */
  spoken: z.boolean(),
});
export type TaskProgress = z.infer<typeof taskProgressSchema>;

export const taskResultSchema = z.object({
  summary: z.string(),
  detail: z.string().optional(),
});
export type TaskResult = z.infer<typeof taskResultSchema>;

/**
 * The serializable view of a Task (no live `abort()` handle — that stays in the
 * daemon's TaskManager). This is what crosses the WS bus.
 */
export const taskSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  createdAt: z.number(),
  state: taskStateSchema,
  progress: z.array(taskProgressSchema),
  result: taskResultSchema.optional(),
  error: z.string().optional(),
  /** Links this task to a Claude Agent SDK session for resume/inspection. */
  sdkSessionId: z.string().optional(),
});
export type Task = z.infer<typeof taskSchema>;

// ---------------------------------------------------------------------------
// Live execution activity — the unthrottled, tool-by-tool feed that lets the
// user watch what the agent is actually doing (files, commands, thinking).
// Strictly additive to (and independent of) the throttled voice TaskProgress.
// ---------------------------------------------------------------------------

export const activityStepKindSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('tool_use'),
    /** SDK tool_use block id; pairs a later tool_result back to this row. */
    toolId: z.string(),
    /** Raw tool name (e.g. 'Bash', 'mcp__srv__tool'). */
    tool: z.string(),
    /** Display label (activityLabel). */
    label: z.string(),
    /** Salient, truncated input (summarizeToolInput): path / command / query. */
    summary: z.string(),
  }),
  z.object({
    kind: z.literal('tool_result'),
    toolId: z.string(),
    ok: z.boolean(),
    /** Truncated result preview (previewToolResult). */
    preview: z.string(),
  }),
  z.object({
    kind: z.literal('thinking'),
    /** Truncated reasoning text. */
    text: z.string(),
  }),
]);
export type ActivityStepKind = z.infer<typeof activityStepKindSchema>;

export const activityStepSchema = z.object({
  ts: z.number(),
  /** Monotonic per-stream ordering (tool_use and tool_result arrive separately). */
  seq: z.number(),
  /** Set for delegated worker tasks. */
  taskId: z.string().optional(),
  /** Set for direct chat turns (correlates to the streamed reply). */
  messageId: z.string().optional(),
  step: activityStepKindSchema,
});
export type ActivityStep = z.infer<typeof activityStepSchema>;

// ---------------------------------------------------------------------------
// Capability manifest — how WorkerKing "knows all it can do".
// ---------------------------------------------------------------------------

export const capabilityKindSchema = z.enum(['skill', 'command', 'agent', 'mcp_tool', 'mcp_server']);
export type CapabilityKind = z.infer<typeof capabilityKindSchema>;

export const capabilityManifestEntrySchema = z.object({
  kind: capabilityKindSchema,
  name: z.string(),
  description: z.string(),
  /** Usage/argument hint for commands (e.g. "<pr-url>"), if the command declares one. */
  argumentHint: z.string().optional(),
  /** Where the capability was discovered. */
  source: z.enum(['user', 'project', 'builtin']),
  /** Filesystem path for skills/commands (the SKILL.md), if applicable. */
  path: z.string().optional(),
  /** Health of an MCP server, if applicable. */
  status: z.enum(['connected', 'error', 'pending']).optional(),
  /** Extra keywords the voice router can match against. */
  routingHints: z.array(z.string()).optional(),
});
export type CapabilityManifestEntry = z.infer<typeof capabilityManifestEntrySchema>;

export const capabilityManifestSchema = z.object({
  /** Bumps on every rebuild so clients can diff/refresh cheaply. */
  version: z.number(),
  builtAt: z.number(),
  entries: z.array(capabilityManifestEntrySchema),
  /**
   * Compact, budget-capped rendering fed to the thin voice model as routing
   * context. The full `entries` list is for Claude Code itself.
   */
  voiceSummary: z.string(),
});
export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;

// ---------------------------------------------------------------------------
// Runtime features — what the daemon actually resolved at boot.
//
// Some settings depend on optional packages that may not be installed. Rather
// than let a control render as working and then silently no-op, the daemon
// reports what it could resolve and the UI disables (with a reason) what it
// cannot.
// ---------------------------------------------------------------------------

export const runtimeFeaturesSchema = z.object({
  /**
   * Semantic memory recall:
   *  - active: the embedding backend loaded and is in use
   *  - available: the optional package resolves, but the setting is off
   *  - unavailable: the optional package is missing (the toggle cannot work)
   */
  semanticMemory: z.enum(['active', 'available', 'unavailable']),
  /** Offline cascade voice: whether all three optional voice packages resolve. */
  localCascade: z.enum(['available', 'unavailable']),
});
export type RuntimeFeatures = z.infer<typeof runtimeFeaturesSchema>;

// ---------------------------------------------------------------------------
// Avatar state — the companion's animation state machine.
// ---------------------------------------------------------------------------

export const avatarStateSchema = z.enum(['idle', 'listening', 'thinking', 'talking', 'alert']);
export type AvatarState = z.infer<typeof avatarStateSchema>;

// ---------------------------------------------------------------------------
// Conversation history — durable, browsable past chats.
// ---------------------------------------------------------------------------

/** A scheduled proactive "watch": a prompt run on a cron to decide if it's worth speaking up. */
export const watchSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  /** 5-field cron expression. */
  cron: z.string(),
  /**
   * IANA timezone the cron is evaluated in (e.g. "America/Chicago"). Omitted =
   * the daemon's local time. Pinning it keeps a working-hours schedule honest
   * when the machine travels or its TZ changes.
   */
  timezone: z.string().optional(),
  /** Shipped with WorkerKing (not user-removable) vs user-created. */
  builtin: z.boolean().optional(),
});
export type Watch = z.infer<typeof watchSchema>;

export const conversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  ts: z.number(),
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;

/** Lightweight metadata for a conversation list (no message bodies). */
export const conversationSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messageCount: z.number(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

// ---------------------------------------------------------------------------
// Configuration — the single source of truth for user-editable settings.
//
// Every process shares this one schema. Electron main owns the persisted
// electron-store file and proxies it to the daemon over WS; the daemon's
// ConfigStore validates against the same schema. Add a field here once and it
// propagates to both sides — no more hand-maintained parallel interfaces.
// ---------------------------------------------------------------------------

/**
 * How the Claude Code toolset (Bash/Write/Edit, etc.) is permitted to run.
 * - `gated`  — destructive tools require an explicit confirmation (fail-closed).
 * - `auto`   — the SDK default (no WorkerKing-side gate).
 * - `readonly` — deny mutating tools outright (used when acting on untrusted
 *   screen-derived input, and selectable by cautious users).
 */
export const toolPermissionModeSchema = z.enum(['gated', 'auto', 'readonly']);
export type ToolPermissionMode = z.infer<typeof toolPermissionModeSchema>;

export const workerKingConfigSchema = z
  .object({
    assistantName: z.string(),
    personality: z.string(),
    /** UI theme preference. */
    theme: z.enum(['system', 'light', 'dark']),
    /** Active voice provider id. */
    voiceProvider: z.enum(['gpt-realtime', 'local-cascade']),
    /** OpenAI Realtime model for the voice layer. */
    openaiModel: z.string(),
    /** Where the Claude backend runs. 'auto' probes Windows then WSL. */
    claudeHost: z.enum(['auto', 'windows', 'wsl']),
    /** Working directory for the Claude Agent SDK session. */
    claudeCwd: z.string().optional(),
    /** Push-to-talk global shortcut accelerator. */
    hotkey: z.string(),
    /** Always-listening wake word ("Hey <name>"); off by default (hotkey-first). */
    wakeWordEnabled: z.boolean(),
    /** Allow Claude to read the foreground window / screenshots; off by default. */
    screenAwareness: z.boolean(),
    /** Require an explicit confirmation before each screenshot; off by default. */
    screenCaptureConsent: z.boolean().optional(),
    /** Persist durable facts/preferences across sessions; on by default. */
    memoryEnabled: z.boolean(),
    /** Use local-embedding semantic recall (falls back to keyword); off by default. */
    semanticMemory: z.boolean(),
    /** Allow scheduled reminders; on by default. */
    remindersEnabled: z.boolean(),
    /** Run scheduled proactive "watch" checks (spends Claude quota); off by default. */
    proactiveEnabled: z.boolean(),
    /** Stream the live tool-by-tool execution feed to the UI; on by default. */
    activityStreamEnabled: z.boolean().optional(),
    /** Include the model's reasoning/thinking in the activity feed; on by default. */
    activityShowThinking: z.boolean().optional(),
    /** Auto-open the activity panel while CLI work is running; on by default. */
    activityAutoOpen: z.boolean().optional(),
    /**
     * How much ambient context the daemon feeds the thin voice model:
     *  - thin: capability list only
     *  - standard (default): + persona + compact orientation (name, time, project, repo names)
     *  - rich: + sprint & remembered facts
     *  - maximal: + full environment listing
     * Screen content is never included at any level.
     */
    voiceContextLevel: z.enum(['thin', 'standard', 'rich', 'maximal']).optional(),
    /** Global hotkey to explain/act on the current clipboard selection. */
    explainHotkey: z.string(),
    /** How the Claude Code toolset is gated; 'gated' by default (fail-closed). */
    toolPermissionMode: toolPermissionModeSchema.optional(),
    /** Preferred microphone deviceId (empty/undefined = system default). */
    inputDeviceId: z.string().optional(),
    /** Preferred audio-output deviceId (empty/undefined = system default). */
    outputDeviceId: z.string().optional(),
    /** The user's display name — how the assistant addresses them. */
    userName: z.string().optional(),
    /**
     * Directories whose subfolders are the user's repos/projects (Windows paths
     * and \\wsl.localhost UNC paths both work). The brain gets these — plus a
     * live listing — as environment context, so "open X" / "work in Y" resolve.
     */
    repoRoots: z.array(z.string()).optional(),
    /** Free-text environment notes folded into the brain's ambient context. */
    envNotes: z.string().optional(),
    /**
     * Global knowledge vault (a claude-obsidian/context2-style wiki). The brain
     * is pointed at it (hot cache + index excerpts) for recall and filing.
     */
    vaultPath: z.string().optional(),
    /**
     * Register the LocalTranscriber MCP server so Claude can call tail_transcript,
     * read_current_transcript, start/stop_transcription, etc. Requires LocalTranscriber
     * to be built (`dotnet build`) and `dotnet` on PATH. Off by default.
     */
    localTranscriberEnabled: z.boolean().optional(),
    /**
     * Path to the LocalTranscriber.Mcp project (used with `dotnet run --project`).
     * Defaults to C:/_repos/LocalTranscriber/src/LocalTranscriber.Mcp.
     */
    localTranscriberPath: z.string().optional(),
  })
  // Unknown keys are preserved (the store historically allowed arbitrary keys).
  .passthrough();

/**
 * Inferred config type. The index signature is kept so `ConfigStore.get(key)` /
 * `.set(key, value)` can still address arbitrary keys, matching prior behavior.
 */
export type WorkerKingConfig = z.infer<typeof workerKingConfigSchema> & {
  [key: string]: unknown;
};

/** Baseline defaults applied before any persisted/overriding values. */
export const DEFAULT_CONFIG: WorkerKingConfig = {
  assistantName: 'WorkerKing',
  theme: 'system',
  personality:
    'A capable, upbeat desktop companion. Concise out loud, thorough when it matters. ' +
    'Delegates real work to Claude Code and narrates progress plainly.',
  voiceProvider: 'gpt-realtime',
  openaiModel: 'gpt-realtime-mini',
  claudeHost: 'auto',
  hotkey: 'Control+Shift+Space',
  wakeWordEnabled: false,
  screenAwareness: false,
  screenCaptureConsent: false,
  memoryEnabled: true,
  semanticMemory: false,
  remindersEnabled: true,
  proactiveEnabled: false,
  activityStreamEnabled: true,
  activityShowThinking: true,
  activityAutoOpen: true,
  voiceContextLevel: 'standard',
  explainHotkey: 'Control+Shift+E',
  toolPermissionMode: 'gated',
  repoRoots: ['C:\\_repos', '\\\\wsl.localhost\\Ubuntu-22.04\\home\\jamesamiller\\repos'],
  // How to LAUNCH the known local apps. Without this the brain can see the repos
  // (repoRoots listing) but has to go read each one's CLAUDE.md to guess a start
  // command — so it either stalls or invents one. Keep in sync with the repos.
  envNotes:
    'Launching known local apps. ' +
    'Sprint/standup dashboard (serves 127.0.0.1:5757, lives in WSL at ~/repos/sprint): ' +
    'run `wsl.exe -d Ubuntu-22.04 -- bash -lc "cd ~/repos/sprint && ./runbook/debug.sh standup"`. ' +
    'That start is idempotent (no-op if 5757 is already healthy) and backgrounds itself; ' +
    'stop with ./runbook/stop-debug.sh. ' +
    'LocalTranscriber (Windows, C:\\_repos\\LocalTranscriber): GUI is ' +
    '`powershell -File C:\\_repos\\LocalTranscriber\\scripts\\run-app.ps1`. For transcription ' +
    'itself prefer the local-transcriber MCP tools (start_transcription, tail_transcript, …) ' +
    'when they are available — no shell needed. ' +
    'General rule: start long-running servers detached/backgrounded, never block a turn on one.',
  localTranscriberEnabled: false,
  localTranscriberPath: 'C:/_repos/LocalTranscriber/src/LocalTranscriber.Mcp',
};

/**
 * The known config keys the app pushes to the daemon (secrets are excluded —
 * they live in safeStorage, never in config). Derived from the schema so it can
 * never drift from the field set. `undefined` values are skipped by the pusher.
 */
export const CONFIG_KEYS = Object.keys(workerKingConfigSchema.shape) as Array<
  keyof WorkerKingConfig
>;

/** Keys that must never be assigned onto a config object (prototype pollution). */
const FORBIDDEN_CONFIG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Validate one config value against the schema field for `key`. Unknown keys
 * are accepted as-is (the store historically allows arbitrary keys); known keys
 * must match their schema type; forbidden keys are always rejected.
 */
export function validateConfigValue(
  key: string,
  value: unknown,
): { ok: true; value: unknown } | { ok: false } {
  if (FORBIDDEN_CONFIG_KEYS.has(key)) return { ok: false };
  const field = (workerKingConfigSchema.shape as Record<string, z.ZodTypeAny>)[key];
  if (!field) return { ok: true, value };
  const result = field.safeParse(value);
  return result.success ? { ok: true, value: result.data } : { ok: false };
}

/**
 * Validate a loaded/partial config blob against the schema, dropping keys with
 * the wrong type rather than trusting the file wholesale ("config is code
 * execution" — never load a config you didn't validate). Returns the subset of
 * recognized, well-typed values; unknown keys pass through.
 *
 * Salvage is per-key on purpose: an all-or-nothing safeParse would let ONE
 * mistyped key silently wipe every other setting back to defaults on the next
 * boot.
 */
export function parseConfig(input: unknown): Partial<WorkerKingConfig> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const checked = validateConfigValue(key, value);
    if (checked.ok) out[key] = checked.value;
  }
  return out as Partial<WorkerKingConfig>;
}
