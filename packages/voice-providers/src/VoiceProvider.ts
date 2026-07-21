import type { JsonValue } from '@workerking/shared';

/**
 * VoiceProvider — the swappable speech interface hosted in the overlay renderer.
 *
 * Provider A (Phase 2) = GptRealtimeProvider (WebRTC to OpenAI Realtime).
 * Provider B (Phase 5) = LocalCascadeProvider (Silero VAD + faster-whisper +
 * Kokoro TTS, optionally with Claude Haiku as the conversational brain).
 *
 * Keeping this a single interface is what lets the two providers swap without
 * touching the daemon, the Supervisor, or the WS plumbing. Phase 0 ships only
 * the types; the concrete providers land in later phases.
 */

export type VoiceProviderState = 'idle' | 'listening' | 'thinking' | 'talking' | 'error';

export interface VoiceToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments (zod-derived at the call site). */
  parameters: Record<string, unknown>;
}

/** Callbacks the provider invokes as the conversation progresses. */
export interface VoiceTurnDelegate {
  /** The model wants to call a supervisor tool; resolve with the tool result. */
  onToolCall(name: string, args: JsonValue): Promise<JsonValue>;
  onUserTranscript(text: string, final: boolean): void;
  onAssistantTranscript(text: string, final: boolean): void;
  onStateChange(state: VoiceProviderState): void;
  /**
   * The user started speaking over the assistant (barge-in). Distinct from a
   * post-speech return to 'listening', so the host can cancel an in-flight reply.
   */
  onSpeechStart?(): void;
  /** Normalized output-audio amplitude (0..1) for the audio-reactive avatar. */
  onAudioLevel?(level: number): void;
  /**
   * `fatal: true` means the provider's session is dead and could not recover —
   * the host should tear down and tell the user how to restart. Non-fatal
   * errors (e.g. one STT failure) leave the session usable.
   */
  onError(err: Error, info?: { fatal?: boolean }): void;
}

export interface VoiceStartOptions {
  /** Assembled thin-voice persona + capability routing summary. */
  systemPrompt: string;
  /** Supervisor tools exposed to the voice model (delegate_to_worker, …). */
  tools: VoiceToolSpec[];
  delegate: VoiceTurnDelegate;
}

export interface VoiceProvider {
  readonly id: 'gpt-realtime' | 'local-cascade';

  start(opts: VoiceStartOptions): Promise<void>;
  stop(): Promise<void>;

  /** Push text into the live session for the model to voice (progress/injections). */
  injectAssistantContext(text: string, opts?: { speakNow?: boolean }): Promise<void>;

  /**
   * Swap the session's standing instructions in place (persona/context change)
   * WITHOUT resetting the conversation. A no-op when no session is live — the
   * next `start()`/`recycleSession()` picks up the new prompt.
   */
  updateInstructions(systemPrompt: string): void;

  /** Barge-in / turn control. */
  interrupt(): Promise<void>;
  setMicEnabled(on: boolean): void;

  /** Re-mint + re-seed the session before it hits its provider length cap. */
  recycleSession(): Promise<void>;
}
