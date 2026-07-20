import { sanitizeForSpeech, type JsonValue } from '@workerking/shared';
import type {
  VoiceProvider,
  VoiceProviderState,
  VoiceStartOptions,
  VoiceToolSpec,
} from './VoiceProvider.js';

/**
 * GptRealtimeProvider — the GPT Realtime voice provider (WebRTC), built on
 * `@openai/agents-realtime`.
 *
 * The concrete `RealtimeSession` is created via an injected `SessionFactory` so
 * this class carries no SDK/browser imports and is fully unit-testable headless
 * with a fake session. The real factory (`createRealtimeSessionFactory`) lives in
 * a separate module the renderer uses.
 */

/**
 * Minimal surface of the session's transport layer (session.transport) we use.
 * Optional on `RealtimeSessionLike` so minimal fakes (and any transport that
 * lacks these) degrade gracefully to the session-level fallbacks.
 */
export interface RealtimeTransportLike {
  on(event: string, handler: (...args: unknown[]) => void): void;
  /** Out-of-band response.create with a custom payload ({conversation:'none', instructions}). */
  requestResponse?(payload?: Record<string, unknown>): void;
  updateSessionConfig?(cfg: Record<string, unknown>): void;
}

/** Minimal surface of `@openai/agents-realtime`'s RealtimeSession we depend on. */
export interface RealtimeSessionLike {
  connect(opts: { apiKey: string | (() => Promise<string>); model?: string }): Promise<void>;
  sendMessage(message: string): void;
  interrupt(): void;
  mute(muted: boolean): void;
  close(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  transport?: RealtimeTransportLike;
}

export interface SessionFactoryConfig {
  systemPrompt: string;
  model: string;
  tools: VoiceToolSpec[];
  /** Invoked when the model calls a tool; resolve with the tool result. */
  onToolCall: (name: string, args: JsonValue) => Promise<JsonValue>;
}

export type SessionFactory = (cfg: SessionFactoryConfig) => RealtimeSessionLike;

export interface GptRealtimeProviderOptions {
  model: string;
  /** Mint an ephemeral client secret (called lazily by the session on connect). */
  mintKey: () => Promise<string>;
  /** Injected session factory (real one in createRealtimeSessionFactory.ts). */
  createSession: SessionFactory;
  /**
   * Recycle the session before OpenAI's hard lifetime cap (~30 min) kills it
   * mid-conversation. 0 disables the timer (tests, or if the cap ever goes away).
   */
  sessionMaxAgeMs?: number;
  /** Backoff before the single auto-recovery attempt after a session drop. */
  retryDelayMs?: number;
}

const DEFAULT_SESSION_MAX_AGE_MS = 25 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 1200;
/** Rolling-summary caps: enough to reseed context, small enough for a prompt. */
const LOG_MAX_LINES = 40;
const LOG_MAX_CHARS = 4000;

interface TranscriptLine {
  role: 'user' | 'assistant';
  text: string;
}

export class GptRealtimeProvider implements VoiceProvider {
  readonly id = 'gpt-realtime' as const;
  private session?: RealtimeSessionLike;
  private startOpts?: VoiceStartOptions;
  private state: VoiceProviderState = 'idle';

  /**
   * Monotonic id of the live session. Bumped by stop()/recycle/recovery before
   * the old session closes, so its event handlers (which capture the epoch)
   * can't flip state or trigger recovery after cutover.
   */
  private sessionEpoch = 0;
  /** True while the model is generating/speaking a response (incl. OOB ones). */
  private turnActive = false;
  /** One OOB injection in flight at a time — overlap = overlapping audio. */
  private oobInFlight = false;
  private injectQueue: string[] = [];
  /** Rolling transcript for reseeding a recycled/recovered session. */
  private transcriptLog: TranscriptLine[] = [];
  private recycleTimer?: ReturnType<typeof setTimeout>;
  /** Recycle requested while a turn was active — fire on the next boundary. */
  private pendingRecycle = false;
  private recovering = false;
  /** Assistant partial transcripts by item id (audio_transcript_delta). */
  private partials = new Map<string, string>();
  /** User items already finalized via input_audio_transcription.completed. */
  private finalizedUserItems = new Set<string>();

  constructor(private readonly opts: GptRealtimeProviderOptions) {}

  async start(opts: VoiceStartOptions): Promise<void> {
    this.startOpts = opts;
    this.transcriptLog = [];
    this.injectQueue = [];
    await this.openSession(opts.systemPrompt);
  }

  /** Open a fresh session (start, recycle, and recovery all funnel through here). */
  private async openSession(instructions: string): Promise<void> {
    const opts = this.startOpts;
    if (!opts) return;
    const epoch = ++this.sessionEpoch;
    // A prior session object still assigned here means its close() (issued by
    // stop()/recycle/recovery) hasn't necessarily reached OpenAI's servers yet —
    // opening a new call before the old call_id is released is the usual cause
    // of "409: A live session already exists for the provided call_id".
    console.debug(
      '[voice:gpt-realtime] openSession',
      fmt({ epoch, hadPriorSession: Boolean(this.session) }),
    );
    this.turnActive = false;
    this.oobInFlight = false;
    this.pendingRecycle = false;
    this.partials.clear();
    const session = this.opts.createSession({
      systemPrompt: instructions,
      model: this.opts.model,
      tools: opts.tools,
      onToolCall: (name, args) => opts.delegate.onToolCall(name, args),
    });
    this.session = session;
    this.wireEvents(session, opts, epoch);
    try {
      await session.connect({ apiKey: this.opts.mintKey, model: this.opts.model });
    } catch (err) {
      console.error(
        '[voice:gpt-realtime] connect failed',
        fmt({ epoch, error: describeError(err) }),
      );
      throw err;
    }
    if (epoch !== this.sessionEpoch) {
      // stop()/another open won while we connected — don't leave this one live.
      console.debug('[voice:gpt-realtime] connected but superseded, closing', fmt({ epoch }));
      session.close();
      return;
    }
    console.debug('[voice:gpt-realtime] connected', fmt({ epoch }));
    this.armRecycleTimer();
    this.setState('listening');
    this.drainInjectQueue();
  }

  private wireEvents(session: RealtimeSessionLike, opts: VoiceStartOptions, epoch: number): void {
    const live = (): boolean => epoch === this.sessionEpoch;
    const transport = session.transport;

    // Assistant audio playback → talking; end/interrupt → back to listening.
    session.on('audio_start', () => {
      if (!live()) return;
      this.turnActive = true;
      this.setState('talking');
    });
    session.on('audio_stopped', () => {
      if (!live()) return;
      this.setState('listening');
      // Without transport turn events, audio end is the only turn boundary.
      if (!transport) this.onTurnDone();
    });
    session.on('audio_interrupted', () => {
      if (!live()) return;
      this.partials.clear();
      this.setState('listening');
      if (!transport) this.onTurnDone();
    });

    // Transcripts: newly added history items carry role + text (finals).
    session.on('history_added', (...args: unknown[]) => {
      if (!live()) return;
      const item = args[0];
      const t = extractTranscript(item);
      if (!t) return;
      if (t.role === 'user') {
        // Skip finals we already emitted from input_audio_transcription.completed.
        if (t.itemId && this.finalizedUserItems.has(t.itemId)) return;
        opts.delegate.onUserTranscript(t.text, true);
      } else {
        if (t.itemId) this.partials.delete(t.itemId);
        opts.delegate.onAssistantTranscript(t.text, true);
      }
      this.appendLog(t.role, t.text);
    });

    // Raw server events (user input transcription streams only here).
    session.on('transport_event', (...args: unknown[]) => {
      if (!live()) return;
      this.onTransportEvent(args[0], opts);
    });

    // Output audio chunks (PCM16) → normalized amplitude for the reactive avatar.
    if (opts.delegate.onAudioLevel) {
      session.on('audio', (...args: unknown[]) => {
        if (!live()) return;
        const evt = args[0] as { data?: ArrayBuffer } | undefined;
        if (evt?.data) opts.delegate.onAudioLevel?.(computePcm16Rms(evt.data));
      });
    }

    // A session error means the realtime connection is toast — try to recover.
    session.on('error', (...args: unknown[]) => {
      if (!live()) return;
      void this.handleDrop(epoch, args[0]);
    });

    if (transport) {
      // Model-turn lifecycle (response.created / response.done) — drives OOB
      // injection gating and turn-boundary recycles.
      transport.on('turn_started', () => {
        if (!live()) return;
        this.turnActive = true;
      });
      transport.on('turn_done', () => {
        if (!live()) return;
        this.onTurnDone();
      });
      // Connection drop (WebRTC/network) → recovery.
      transport.on('connection_change', (...args: unknown[]) => {
        if (!live()) return;
        if (args[0] === 'disconnected') void this.handleDrop(epoch, new Error('connection lost'));
      });
      // Assistant partial transcripts.
      transport.on('audio_transcript_delta', (...args: unknown[]) => {
        if (!live()) return;
        const evt = args[0] as { itemId?: string; delta?: string } | undefined;
        if (!evt?.itemId || typeof evt.delta !== 'string') return;
        const acc = (this.partials.get(evt.itemId) ?? '') + evt.delta;
        this.partials.set(evt.itemId, acc);
        opts.delegate.onAssistantTranscript(acc, false);
      });
    }
  }

  /** User input-audio transcription streams only as raw server events. */
  private onTransportEvent(evt: unknown, opts: VoiceStartOptions): void {
    if (!evt || typeof evt !== 'object') return;
    const e = evt as { type?: string; item_id?: string; delta?: string; transcript?: string };
    if (e.type === 'conversation.item.input_audio_transcription.delta') {
      if (!e.item_id || typeof e.delta !== 'string') return;
      const key = `user:${e.item_id}`;
      const acc = (this.partials.get(key) ?? '') + e.delta;
      this.partials.set(key, acc);
      opts.delegate.onUserTranscript(acc, false);
    } else if (e.type === 'conversation.item.input_audio_transcription.completed') {
      if (!e.item_id || typeof e.transcript !== 'string') return;
      this.partials.delete(`user:${e.item_id}`);
      this.finalizedUserItems.add(e.item_id);
      const text = e.transcript.trim();
      if (!text) return;
      opts.delegate.onUserTranscript(text, true);
      this.appendLog('user', text);
    }
  }

  /** Turn boundary: recycle if one is pending, otherwise drain queued injections. */
  private onTurnDone(): void {
    this.turnActive = false;
    this.oobInFlight = false;
    if (this.pendingRecycle) {
      this.pendingRecycle = false;
      void this.recycleSession();
      return;
    }
    this.drainInjectQueue();
  }

  private setState(state: VoiceProviderState): void {
    if (state === this.state) return;
    this.state = state;
    this.startOpts?.delegate.onStateChange(state);
  }

  private appendLog(role: 'user' | 'assistant', text: string): void {
    this.transcriptLog.push({ role, text });
    if (this.transcriptLog.length > LOG_MAX_LINES) {
      this.transcriptLog.splice(0, this.transcriptLog.length - LOG_MAX_LINES);
    }
  }

  /** System prompt + rolling transcript, so a fresh session continues seamlessly. */
  private buildReseedInstructions(): string {
    const base = this.startOpts?.systemPrompt ?? '';
    if (this.transcriptLog.length === 0) return base;
    let lines = this.transcriptLog.map((l) => `${l.role}: ${l.text}`);
    let joined = lines.join('\n');
    while (joined.length > LOG_MAX_CHARS && lines.length > 1) {
      lines = lines.slice(1);
      joined = lines.join('\n');
    }
    return (
      `${base}\n\n# Conversation so far\n` +
      `You were mid-conversation; continue seamlessly and do not re-greet the user.\n${joined}`
    );
  }

  private armRecycleTimer(): void {
    this.clearRecycleTimer();
    const maxAge = this.opts.sessionMaxAgeMs ?? DEFAULT_SESSION_MAX_AGE_MS;
    if (maxAge <= 0) return;
    this.recycleTimer = setTimeout(() => {
      // Never cut a session mid-turn — wait for the boundary.
      if (this.turnActive) this.pendingRecycle = true;
      else void this.recycleSession();
    }, maxAge);
  }

  private clearRecycleTimer(): void {
    if (this.recycleTimer !== undefined) {
      clearTimeout(this.recycleTimer);
      this.recycleTimer = undefined;
    }
  }

  /**
   * A session error or transport disconnect while live: one automatic recovery
   * attempt (fresh key, fresh session, reseeded context). Success is silent;
   * failure surfaces `onError(err, {fatal:true})` so the host can tell the user.
   */
  private async handleDrop(epoch: number, cause: unknown): Promise<void> {
    if (epoch !== this.sessionEpoch || this.recovering) return;
    console.warn(
      '[voice:gpt-realtime] session dropped, attempting recovery',
      fmt({ epoch, cause: describeError(cause) }),
    );
    this.recovering = true;
    this.sessionEpoch++; // deaden the dropped session's handlers
    const myEpoch = this.sessionEpoch;
    try {
      this.session?.close();
    } catch {
      /* already dead */
    }
    this.clearRecycleTimer();
    this.setState('thinking');
    try {
      await delay(this.opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
      if (myEpoch !== this.sessionEpoch) return; // stop() won during backoff
      await this.openSession(this.buildReseedInstructions());
      console.info('[voice:gpt-realtime] recovery succeeded', fmt({ epoch: myEpoch }));
    } catch (retryErr) {
      console.error(
        '[voice:gpt-realtime] recovery failed, giving up',
        fmt({ epoch: myEpoch, error: describeError(retryErr) }),
      );
      try {
        this.session?.close();
      } catch {
        /* ignore */
      }
      this.session = undefined;
      this.setState('error');
      this.startOpts?.delegate.onError(toError(retryErr ?? cause), { fatal: true });
    } finally {
      this.recovering = false;
    }
  }

  async stop(): Promise<void> {
    console.debug('[voice:gpt-realtime] stop', fmt({ epoch: this.sessionEpoch }));
    this.sessionEpoch++; // deaden handlers + abort any in-flight open/recovery
    this.clearRecycleTimer();
    this.pendingRecycle = false;
    this.injectQueue = [];
    this.turnActive = false;
    this.oobInFlight = false;
    this.partials.clear();
    this.finalizedUserItems.clear();
    this.session?.close();
    this.session = undefined;
    this.setState('idle');
  }

  /**
   * Queue text (task progress, proactive notices) to be spoken out-of-band.
   * Sent one per turn boundary via `transport.requestResponse` with
   * `conversation:'none'` — the model voices it verbatim without it becoming a
   * user message (no paraphrase drift, no extra conversation turns, no billed
   * response to a fake user input). Falls back to `sendMessage` when the
   * transport surface is unavailable.
   */
  async injectAssistantContext(text: string, opts?: { speakNow?: boolean }): Promise<void> {
    void opts;
    const spoken = sanitizeForSpeech(text);
    if (!spoken || !this.session) return;
    this.injectQueue.push(spoken);
    // OOB responses bypass history — log ourselves so recycles keep the context.
    this.appendLog('assistant', spoken);
    this.drainInjectQueue();
  }

  private drainInjectQueue(): void {
    if (this.turnActive || this.oobInFlight) return;
    const text = this.injectQueue.shift();
    if (text === undefined) return;
    const transport = this.session?.transport;
    if (transport?.requestResponse) {
      // The OOB response itself emits turn_started/turn_done, which releases
      // oobInFlight and drains the next queued item — one at a time, no overlap.
      this.oobInFlight = true;
      transport.requestResponse({
        conversation: 'none',
        instructions: `Read this update to the user verbatim, naturally: "${text}"`,
      });
    } else {
      this.session?.sendMessage(text);
    }
  }

  async interrupt(): Promise<void> {
    this.session?.interrupt();
    this.setState('listening');
  }

  setMicEnabled(on: boolean): void {
    // Note: mute() keeps the capture track open (fast unmute, but the OS mic
    // indicator stays lit). Accepted tradeoff for the realtime path.
    this.session?.mute(!on);
  }

  /**
   * Re-mint + reconnect with a fresh ephemeral key and a new session instance
   * before the provider hits its session-length cap, reseeding the rolling
   * transcript so the conversation continues seamlessly. Deferred to the next
   * turn boundary if the model is mid-response.
   */
  async recycleSession(): Promise<void> {
    if (!this.startOpts || !this.session) return;
    if (this.turnActive) {
      this.pendingRecycle = true;
      return;
    }
    console.debug('[voice:gpt-realtime] recycling session', fmt({ epoch: this.sessionEpoch }));
    this.clearRecycleTimer();
    this.sessionEpoch++; // deaden the old session's handlers before closing it
    try {
      this.session.close();
    } catch {
      /* ignore */
    }
    await this.openSession(this.buildReseedInstructions());
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Electron's `webContents.on('console-message', ...)` (how these log lines
 * reach the daemon/app log files — see main/index.ts) hands back a single
 * flattened string, not the original arguments — a plain object passed as a
 * second `console.debug` arg prints as the useless `[object Object]`. Inline
 * it into the message string instead.
 */
function fmt(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Session `error` events and rejected `connect()` calls often carry a raw SDK
 * error/event object, or a WebIDL exception (e.g. a `DOMException` from
 * WebRTC/getUserMedia), rather than a plain `Error` — logging one bare prints
 * the useless `[object Object]`/`[object DOMException]`. Pull out whatever's
 * actually informative instead.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  if (err && typeof err === 'object') {
    // DOMException-shaped: name/message live on the prototype as accessors, so
    // JSON.stringify(err) below would otherwise yield "{}".
    const named = err as { name?: unknown; message?: unknown };
    if (typeof named.name === 'string' && typeof named.message === 'string') {
      return `${named.name}: ${named.message}`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

/**
 * Compute a normalized (0..1) loudness from a PCM16 audio chunk.
 * RMS of the 16-bit samples / full scale, lightly boosted so quiet speech still
 * moves the avatar. Transport-agnostic (works for WebRTC and WebSocket audio).
 */
export function computePcm16Rms(buffer: ArrayBuffer, boost = 1.8): number {
  // Int16Array requires an even byte length; a misaligned chunk would throw.
  const evenBytes = buffer.byteLength & ~1;
  const samples = new Int16Array(buffer, 0, evenBytes / 2);
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] / 32768;
    sumSquares += s * s;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return Math.max(0, Math.min(1, rms * boost));
}

/** Pull role + text (and item id when present) out of a RealtimeItem-shaped history entry. */
export function extractTranscript(
  item: unknown,
): { role: 'user' | 'assistant'; text: string; itemId?: string } | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const it = item as {
    type?: string;
    role?: string;
    itemId?: string;
    id?: string;
    content?: Array<{ type?: string; text?: string; transcript?: string }>;
  };
  if (it.type !== 'message' || (it.role !== 'user' && it.role !== 'assistant')) return undefined;
  const text = (it.content ?? [])
    .map((c) => c.text ?? c.transcript ?? '')
    .join('')
    .trim();
  if (!text) return undefined;
  return { role: it.role, text, itemId: it.itemId ?? it.id };
}
