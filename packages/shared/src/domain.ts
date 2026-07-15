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
