import { z } from 'zod';

/**
 * Domain types shared across every WorkerKing process.
 *
 * These are the nouns of the system: Tasks that Claude Code runs, the capability
 * manifest that tells the voice layer what WorkerKing can do, and the character
 * card that defines its name/personality/voice/avatar.
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
// Capability manifest — how WorkerKing "knows all it can do".
// ---------------------------------------------------------------------------

export const capabilityKindSchema = z.enum([
  'skill',
  'command',
  'agent',
  'mcp_tool',
  'mcp_server',
]);
export type CapabilityKind = z.infer<typeof capabilityKindSchema>;

export const capabilityManifestEntrySchema = z.object({
  kind: capabilityKindSchema,
  name: z.string(),
  description: z.string(),
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
// Character card — SillyTavern chara_card_v2 compatible personality definition.
// ---------------------------------------------------------------------------

export const characterCardExtensionsSchema = z
  .object({
    workerking: z
      .object({
        voice: z
          .object({
            provider: z.enum(['gpt-realtime', 'local-cascade']),
            voiceId: z.string(),
          })
          .optional(),
        avatar: z
          .object({
            /** Name of a pack under resources/avatars/<pack>. */
            pack: z.string(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();
export type CharacterCardExtensions = z.infer<typeof characterCardExtensionsSchema>;

export const characterCardV2Schema = z.object({
  spec: z.literal('chara_card_v2'),
  spec_version: z.literal('2.0'),
  data: z.object({
    name: z.string(),
    description: z.string().default(''),
    personality: z.string().default(''),
    scenario: z.string().default(''),
    first_mes: z.string().default(''),
    mes_example: z.string().default(''),
    /** Becomes the `append` persona layered onto Claude Code's preset prompt. */
    system_prompt: z.string().default(''),
    post_history_instructions: z.string().default(''),
    extensions: characterCardExtensionsSchema.optional(),
    /** Base64 image or a resource path. */
    avatar: z.string().optional(),
  }),
});
export type CharacterCardV2 = z.infer<typeof characterCardV2Schema>;

/**
 * The result of assembling a character card + config into runtime persona.
 */
export const assembledPersonaSchema = z.object({
  systemPrompt: z.object({
    type: z.literal('preset'),
    preset: z.literal('claude_code'),
    append: z.string(),
  }),
  /** Persona string for the thin voice model (kept short). */
  voiceSystemPrompt: z.string(),
  voice: z.object({
    provider: z.enum(['gpt-realtime', 'local-cascade']),
    voiceId: z.string(),
  }),
  avatarPack: z.string(),
});
export type AssembledPersona = z.infer<typeof assembledPersonaSchema>;

// ---------------------------------------------------------------------------
// Avatar state — the companion's animation state machine.
// ---------------------------------------------------------------------------

export const avatarStateSchema = z.enum([
  'idle',
  'listening',
  'thinking',
  'talking',
  'alert',
]);
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
    /** Global hotkey to explain/act on the current clipboard selection. */
    explainHotkey: z.string(),
    /** How the Claude Code toolset is gated; 'gated' by default (fail-closed). */
    toolPermissionMode: toolPermissionModeSchema.optional(),
    /** Preferred microphone deviceId (empty/undefined = system default). */
    inputDeviceId: z.string().optional(),
    /** Preferred audio-output deviceId (empty/undefined = system default). */
    outputDeviceId: z.string().optional(),
    /** The user's display name, for {{user}} in character cards. */
    userName: z.string().optional(),
    /** Active SillyTavern chara_card_v2 (object), if the user imported one. */
    characterCard: z.unknown().optional(),
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
  explainHotkey: 'Control+Shift+E',
  toolPermissionMode: 'gated',
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
