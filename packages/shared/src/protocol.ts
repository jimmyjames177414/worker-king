import { z } from 'zod';
import {
  taskSchema,
  taskProgressSchema,
  activityStepSchema,
  capabilityManifestSchema,
  avatarStateSchema,
  conversationMessageSchema,
  conversationSummarySchema,
  watchSchema,
} from './domain.js';

/**
 * The single typed WebSocket protocol every WorkerKing process speaks.
 *
 * Renderer <-> daemon and main <-> daemon share this one envelope. Electron IPC
 * is reserved only for things that are inherently main-process (window control,
 * tray, safeStorage). Everything else — voice tool calls, task progress, avatar
 * state, config, chat — rides this bus.
 *
 * Design notes:
 *  - `id` correlates request/response; a response sets `replyTo` to the request id.
 *  - Broadcasts (task.*, avatar.state, capability.updated) are fire-and-forget.
 *  - Every payload has a zod schema in `payloadSchemas`; `parseEnvelope` validates
 *    the envelope shape and the payload for its kind in one step.
 */

export const PROTOCOL_VERSION = 1 as const;

export const wsRoleSchema = z.enum(['main', 'overlay', 'chat', 'daemon']);
export type WsRole = z.infer<typeof wsRoleSchema>;

// ---------------------------------------------------------------------------
// Per-kind payload schemas.
// ---------------------------------------------------------------------------

const helloPayload = z.object({
  role: wsRoleSchema,
  /** One-time token minted by the daemon and handed to clients out of band. */
  token: z.string(),
  clientVersion: z.string().optional(),
});

const welcomePayload = z.object({
  /** Daemon-assigned connection id. */
  connectionId: z.string(),
  daemonVersion: z.string(),
  /** Whether the daemon is running natively or inside WSL. */
  host: z.enum(['windows', 'wsl', 'unknown']),
});

const voiceToolCallPayload = z.object({
  name: z.string(),
  args: z.unknown(),
});

const voiceToolResultPayload = z.object({
  /** JSON-serializable result handed back to the voice model. */
  result: z.unknown(),
  isError: z.boolean().default(false),
});

const voiceTranscriptPayload = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  final: z.boolean(),
});

const voiceStatePayload = z.object({
  state: z.enum(['idle', 'listening', 'thinking', 'talking', 'error']),
});

const voiceInjectPayload = z.object({
  /** Text for the provider to voice (progress update, side note). */
  text: z.string(),
  /** If true, speak immediately; otherwise queue around the user's turn. */
  speakNow: z.boolean().default(false),
});

const voiceRecyclePayload = z.object({
  reason: z.enum(['session_limit', 'persona_change', 'manual']).default('manual'),
});

/**
 * The full voice system prompt, assembled by the daemon (behavioral base +
 * capability summary + level-gated ambient context). Broadcast to the overlay,
 * which uses it at session start and hot-patches a live session when it changes.
 */
const voiceContextPayload = z.object({
  systemPrompt: z.string(),
});

/** Normalized output-audio amplitude (0..1) for the audio-reactive avatar. */
const voiceAudioLevelPayload = z.object({
  level: z.number().min(0).max(1),
});

// Screen awareness (daemon <-> Electron main). Capture happens in main (Windows),
// even when the daemon runs in WSL, so it crosses the WS bus as a request/response.
const screenCaptureRequestPayload = z.object({
  /** 'window' = foreground window only; 'screen' = full primary display. */
  target: z.enum(['window', 'screen']).default('window'),
  /** Include a screenshot image, or just the window/title metadata. */
  includeImage: z.boolean().default(true),
});
const screenCaptureResultPayload = z.object({
  ok: z.boolean(),
  /** Foreground window/app title, when available. */
  activeWindowTitle: z.string().optional(),
  /** PNG screenshot as a data URI (data:image/png;base64,...), when requested. */
  imageDataUrl: z.string().optional(),
  error: z.string().optional(),
});

// Proactive/ambient: WorkerKing surfaces something unprompted (reminders, watch
// heads-ups, or a `notify` tool call). Overlay speaks it; main shows a toast.
// Tool-permission gate (daemon -> UI -> daemon). When the Claude Code toolset is
// 'gated', a destructive tool call round-trips to a UI client for fail-closed
// approval before it runs; the reply sets `replyTo` to the request id.
const toolConfirmRequestPayload = z.object({
  /** Tool being requested, e.g. "Bash" or "Write". */
  tool: z.string(),
  /** Human-readable one-liner describing what it wants to do. */
  summary: z.string(),
});
const toolConfirmResponsePayload = z.object({
  approved: z.boolean(),
});

const proactiveNotifyPayload = z.object({
  text: z.string(),
  level: z.enum(['info', 'warn', 'success']).default('info'),
  /** Speak it aloud (vs. toast-only). */
  speak: z.boolean().default(true),
  /** Origin, for logging/UX, e.g. 'reminder' | 'watch' | 'notify-tool'. */
  source: z.string().optional(),
});

const taskCreatedPayload = z.object({ task: taskSchema });
const taskUpdatedPayload = z.object({ task: taskSchema });

// Conversation history (renderer request -> daemon result, keyed by kind).
const historyListPayload = z.object({});
const historyListResultPayload = z.object({
  conversations: z.array(conversationSummarySchema),
});
const historyLoadPayload = z.object({ conversationId: z.string() });
const historyLoadResultPayload = z.object({
  conversationId: z.string(),
  messages: z.array(conversationMessageSchema),
});
const historyNewPayload = z.object({});
const historyNewResultPayload = z.object({ conversationId: z.string() });

// Proactive watches management (renderer request -> daemon result).
const watchesListPayload = z.object({});
const watchesListResultPayload = z.object({ watches: z.array(watchSchema) });
const watchesAddPayload = z.object({ prompt: z.string(), cron: z.string() });
const watchesRemovePayload = z.object({ id: z.string() });
const taskProgressPayload = z.object({
  taskId: z.string(),
  progress: taskProgressSchema,
});
const taskDonePayload = z.object({ task: taskSchema });
const taskErrorPayload = z.object({ taskId: z.string(), error: z.string() });
const taskCancelledPayload = z.object({ taskId: z.string() });

// Live execution activity — one unthrottled step of the tool-by-tool feed.
const activityStepPayload = activityStepSchema;

const avatarStatePayload = z.object({
  state: avatarStateSchema,
  emote: z.string().optional(),
});

const capabilityUpdatedPayload = z.object({
  manifest: capabilityManifestSchema,
});

const configGetPayload = z.object({ key: z.string().optional() });
const configSetPayload = z.object({ key: z.string(), value: z.unknown() });
const configChangedPayload = z.object({
  key: z.string(),
  value: z.unknown(),
});

const chatUserMessagePayload = z.object({
  text: z.string(),
  /** Optional client-supplied id to correlate the streamed reply. */
  messageId: z.string().optional(),
});
const chatAssistantDeltaPayload = z.object({
  messageId: z.string().optional(),
  delta: z.string(),
});
const chatAssistantDonePayload = z.object({
  messageId: z.string().optional(),
  text: z.string(),
});

const pingPayload = z.object({}).default({});
const pongPayload = z.object({}).default({});
const shutdownPayload = z.object({ reason: z.string().optional() });
const errorPayload = z.object({
  message: z.string(),
  /** Machine-readable code, e.g. 'auth_error', 'bad_message'. */
  code: z.string().optional(),
});

/**
 * The registry mapping every message kind to its payload schema.
 * Adding a message = add one entry here and the union/types update automatically.
 */
export const payloadSchemas = {
  hello: helloPayload,
  welcome: welcomePayload,

  'voice.tool_call': voiceToolCallPayload,
  'voice.tool_result': voiceToolResultPayload,
  'voice.transcript': voiceTranscriptPayload,
  'voice.state': voiceStatePayload,
  'voice.inject': voiceInjectPayload,
  'voice.recycle': voiceRecyclePayload,
  'voice.context': voiceContextPayload,
  'voice.audio_level': voiceAudioLevelPayload,

  'screen.capture_request': screenCaptureRequestPayload,
  'screen.capture_result': screenCaptureResultPayload,

  'tool.confirm_request': toolConfirmRequestPayload,
  'tool.confirm_response': toolConfirmResponsePayload,

  'proactive.notify': proactiveNotifyPayload,

  'task.created': taskCreatedPayload,
  'task.updated': taskUpdatedPayload,
  'task.progress': taskProgressPayload,
  'task.done': taskDonePayload,
  'task.error': taskErrorPayload,
  'task.cancelled': taskCancelledPayload,

  'activity.step': activityStepPayload,

  'avatar.state': avatarStatePayload,

  'capability.updated': capabilityUpdatedPayload,

  'history.list': historyListPayload,
  'history.list_result': historyListResultPayload,
  'history.load': historyLoadPayload,
  'history.load_result': historyLoadResultPayload,
  'history.new': historyNewPayload,
  'history.new_result': historyNewResultPayload,

  'watches.list': watchesListPayload,
  'watches.list_result': watchesListResultPayload,
  'watches.add': watchesAddPayload,
  'watches.remove': watchesRemovePayload,

  'config.get': configGetPayload,
  'config.set': configSetPayload,
  'config.changed': configChangedPayload,

  'chat.user_message': chatUserMessagePayload,
  'chat.assistant_delta': chatAssistantDeltaPayload,
  'chat.assistant_done': chatAssistantDonePayload,

  ping: pingPayload,
  pong: pongPayload,
  shutdown: shutdownPayload,
  error: errorPayload,
} as const;

export type WsMessageKind = keyof typeof payloadSchemas;

export const wsMessageKindSchema = z.enum(
  Object.keys(payloadSchemas) as [WsMessageKind, ...WsMessageKind[]],
);

/** Payload TypeScript type for a given kind. */
export type PayloadOf<K extends WsMessageKind> = z.infer<(typeof payloadSchemas)[K]>;

// ---------------------------------------------------------------------------
// The envelope.
// ---------------------------------------------------------------------------

export interface WsEnvelope<K extends WsMessageKind = WsMessageKind> {
  v: typeof PROTOCOL_VERSION;
  id: string;
  kind: K;
  ts: number;
  payload: PayloadOf<K>;
  /** Set on responses to correlate with the originating request's `id`. */
  replyTo?: string;
}

/** Base envelope schema (payload validated separately per-kind). */
const envelopeBaseSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string(),
  kind: wsMessageKindSchema,
  ts: z.number(),
  payload: z.unknown(),
  replyTo: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Build / parse helpers.
// ---------------------------------------------------------------------------

/**
 * Deterministic id generator injected by callers.
 *
 * The shared package stays environment-agnostic (no crypto/Date import) so it
 * works identically in the daemon, Electron main, and the renderer. Callers pass
 * an id factory and timestamp.
 */
export interface EnvelopeContext {
  newId: () => string;
  now: () => number;
}

export function makeEnvelope<K extends WsMessageKind>(
  ctx: EnvelopeContext,
  kind: K,
  payload: PayloadOf<K>,
  opts?: { replyTo?: string },
): WsEnvelope<K> {
  // Validate the payload as we build so we never emit a malformed message.
  const parsed = payloadSchemas[kind].parse(payload) as PayloadOf<K>;
  return {
    v: PROTOCOL_VERSION,
    id: ctx.newId(),
    kind,
    ts: ctx.now(),
    payload: parsed,
    ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}),
  };
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly code: 'bad_json' | 'bad_envelope' | 'bad_payload',
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/**
 * Parse and fully validate a raw incoming message (string or object).
 * Throws ProtocolError on any malformed input.
 */
export function parseEnvelope(raw: unknown): WsEnvelope {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new ProtocolError('Message is not valid JSON', 'bad_json');
    }
  }

  const base = envelopeBaseSchema.safeParse(obj);
  if (!base.success) {
    throw new ProtocolError(
      `Invalid envelope: ${base.error.issues.map((i) => i.message).join('; ')}`,
      'bad_envelope',
    );
  }

  const kind = base.data.kind;
  const payloadResult = payloadSchemas[kind].safeParse(base.data.payload);
  if (!payloadResult.success) {
    throw new ProtocolError(
      `Invalid payload for kind "${kind}": ${payloadResult.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`,
      'bad_payload',
    );
  }

  return {
    v: base.data.v,
    id: base.data.id,
    kind,
    ts: base.data.ts,
    payload: payloadResult.data,
    ...(base.data.replyTo ? { replyTo: base.data.replyTo } : {}),
  } as WsEnvelope;
}

/** Serialize an envelope to a wire string. */
export function serializeEnvelope(env: WsEnvelope): string {
  return JSON.stringify(env);
}

/** Type guard narrowing an envelope to a specific kind. */
export function isKind<K extends WsMessageKind>(env: WsEnvelope, kind: K): env is WsEnvelope<K> {
  return env.kind === kind;
}
