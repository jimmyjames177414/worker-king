import type { JsonValue } from '@workerking/shared';
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

/** Minimal surface of `@openai/agents-realtime`'s RealtimeSession we depend on. */
export interface RealtimeSessionLike {
  connect(opts: { apiKey: string | (() => Promise<string>); model?: string }): Promise<void>;
  sendMessage(message: string): void;
  interrupt(): void;
  mute(muted: boolean): void;
  close(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
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
}

export class GptRealtimeProvider implements VoiceProvider {
  readonly id = 'gpt-realtime' as const;
  private session?: RealtimeSessionLike;
  private startOpts?: VoiceStartOptions;
  private state: VoiceProviderState = 'idle';

  constructor(private readonly opts: GptRealtimeProviderOptions) {}

  async start(opts: VoiceStartOptions): Promise<void> {
    this.startOpts = opts;
    const session = this.opts.createSession({
      systemPrompt: opts.systemPrompt,
      model: this.opts.model,
      tools: opts.tools,
      onToolCall: (name, args) => opts.delegate.onToolCall(name, args),
    });
    this.session = session;
    this.wireEvents(session, opts);
    await session.connect({ apiKey: this.opts.mintKey, model: this.opts.model });
    this.setState('listening');
  }

  private wireEvents(session: RealtimeSessionLike, opts: VoiceStartOptions): void {
    // Assistant audio playback → talking; end/interrupt → back to listening.
    session.on('audio_start', () => this.setState('talking'));
    session.on('audio_stopped', () => this.setState('listening'));
    session.on('audio_interrupted', () => this.setState('listening'));

    // Transcripts: newly added history items carry role + text.
    session.on('history_added', (...args: unknown[]) => {
      const item = args[0];
      const t = extractTranscript(item);
      if (!t) return;
      if (t.role === 'user') opts.delegate.onUserTranscript(t.text, true);
      else opts.delegate.onAssistantTranscript(t.text, true);
    });

    // Output audio chunks (PCM16) → normalized amplitude for the reactive avatar.
    if (opts.delegate.onAudioLevel) {
      session.on('audio', (...args: unknown[]) => {
        const evt = args[0] as { data?: ArrayBuffer } | undefined;
        if (evt?.data) opts.delegate.onAudioLevel?.(computePcm16Rms(evt.data));
      });
    }

    session.on('error', (...args: unknown[]) => {
      const err = args[0];
      this.setState('error');
      opts.delegate.onError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  private setState(state: VoiceProviderState): void {
    if (state === this.state) return;
    this.state = state;
    this.startOpts?.delegate.onStateChange(state);
  }

  async stop(): Promise<void> {
    this.session?.close();
    this.session = undefined;
    this.setState('idle');
  }

  async injectAssistantContext(text: string, opts?: { speakNow?: boolean }): Promise<void> {
    // Phase 2: surface progress/context by feeding it to the session. Phase 3
    // refines this into turn-gated out-of-band responses; for now a message is
    // enough to make the model voice it.
    void opts;
    this.session?.sendMessage(text);
  }

  async interrupt(): Promise<void> {
    this.session?.interrupt();
    this.setState('listening');
  }

  setMicEnabled(on: boolean): void {
    this.session?.mute(!on);
  }

  async recycleSession(): Promise<void> {
    // Re-mint + reconnect with a fresh ephemeral key before the provider hits its
    // session-length cap. Reseeding a rolling summary is added in a later slice.
    if (!this.startOpts) return;
    this.session?.close();
    await this.start(this.startOpts);
  }
}

/**
 * Compute a normalized (0..1) loudness from a PCM16 audio chunk.
 * RMS of the 16-bit samples / full scale, lightly boosted so quiet speech still
 * moves the avatar. Transport-agnostic (works for WebRTC and WebSocket audio).
 */
export function computePcm16Rms(buffer: ArrayBuffer, boost = 1.8): number {
  const samples = new Int16Array(buffer);
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] / 32768;
    sumSquares += s * s;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return Math.max(0, Math.min(1, rms * boost));
}

/** Pull role + text out of a RealtimeItem-shaped history entry. */
export function extractTranscript(item: unknown): { role: 'user' | 'assistant'; text: string } | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const it = item as {
    type?: string;
    role?: string;
    content?: Array<{ type?: string; text?: string; transcript?: string }>;
  };
  if (it.type !== 'message' || (it.role !== 'user' && it.role !== 'assistant')) return undefined;
  const text = (it.content ?? [])
    .map((c) => c.text ?? c.transcript ?? '')
    .join('')
    .trim();
  if (!text) return undefined;
  return { role: it.role, text };
}
