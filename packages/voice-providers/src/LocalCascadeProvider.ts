import { sanitizeForSpeech } from '@workerking/shared';
import type {
  VoiceProvider,
  VoiceProviderState,
  VoiceStartOptions,
} from './VoiceProvider.js';

/**
 * LocalCascadeProvider — the free/offline voice provider (Provider B).
 *
 * A cascaded pipeline: mic → VAD → STT → (daemon Claude brain) → TTS → speaker.
 * The key idea: **Claude is the voice brain** (via the daemon chat path in
 * VoiceHost); this provider is pure audio I/O. That keeps it swappable with the
 * GPT Realtime provider behind the same `VoiceProvider` interface, at ~$0/min and
 * fully private.
 *
 * The STT/TTS/VAD engines are injected so the orchestration is unit-testable with
 * fakes; real engines (vad-web + whisper onnx + kokoro) are documented drop-ins.
 */

/** Voice Activity Detection: emits utterance boundaries over a mic stream. */
export interface VadEngine {
  /** Start listening; call onUtterance with captured PCM when speech ends. */
  start(onUtterance: (pcm: Float32Array) => void, onSpeechStart?: () => void): Promise<void>;
  stop(): void;
}

/** Speech-to-text. */
export interface SttEngine {
  transcribe(pcm: Float32Array): Promise<string>;
}

/** Text-to-speech + playback. */
export interface TtsEngine {
  /** Synthesize and play `text`; resolves when playback finishes. */
  speak(text: string): Promise<void>;
  /** Stop any in-progress playback (barge-in). */
  stop(): void;
}

export interface LocalCascadeOptions {
  vad: VadEngine;
  stt: SttEngine;
  tts: TtsEngine;
}

export class LocalCascadeProvider implements VoiceProvider {
  readonly id = 'local-cascade' as const;
  private startOpts?: VoiceStartOptions;
  private state: VoiceProviderState = 'idle';
  private running = false;
  private micEnabled = true;

  constructor(private readonly engines: LocalCascadeOptions) {}

  async start(opts: VoiceStartOptions): Promise<void> {
    this.startOpts = opts;
    this.running = true;
    await this.engines.vad.start(
      (pcm) => void this.onUtterance(pcm),
      () => {
        // User started speaking → cut off any current TTS (barge-in) and listen.
        // Ignore while muted or stopped so muting truly silences the mic.
        if (!this.running || !this.micEnabled) return;
        this.engines.tts.stop();
        // Signal barge-in so the host can drop an in-flight/queued reply (N2).
        this.startOpts?.delegate.onSpeechStart?.();
        this.setState('listening');
      },
    );
    this.setState('listening');
  }

  private async onUtterance(pcm: Float32Array): Promise<void> {
    if (!this.running || !this.micEnabled) return;
    this.setState('thinking');
    try {
      const text = await this.engines.stt.transcribe(pcm);
      if (text.trim()) this.startOpts?.delegate.onUserTranscript(text, true);
      // The assistant reply arrives via injectAssistantContext() from VoiceHost
      // (which routes the transcript to the daemon Claude brain).
    } catch (err) {
      this.setState('error');
      this.startOpts?.delegate.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private setState(state: VoiceProviderState): void {
    if (state === this.state) return;
    this.state = state;
    this.startOpts?.delegate.onStateChange(state);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.engines.vad.stop();
    this.engines.tts.stop();
    this.setState('idle');
  }

  /** Monotonic id per spoken utterance, so a superseded one can't clobber state. */
  private speakSeq = 0;

  /** Speak assistant text (the brain's reply, or a progress update). */
  async injectAssistantContext(text: string): Promise<void> {
    // A reply landing after stop() must not synthesize/speak into a dead session.
    if (!this.running) return;
    if (!text.trim()) return;
    // Flatten markdown/code/reasoning so the TTS engine never voices literal
    // backticks, asterisks, or a <think> block (N4).
    const spoken = sanitizeForSpeech(text);
    if (!spoken) return;
    this.startOpts?.delegate.onAssistantTranscript(spoken, true);
    this.setState('talking');
    const seq = ++this.speakSeq;
    try {
      await this.engines.tts.speak(spoken);
    } finally {
      // Only the *latest* utterance resets state — a barged-in/superseded one
      // resolving late must not flip 'thinking' (set by the new STT) back to
      // 'listening' (the state-flap).
      if (this.running && seq === this.speakSeq) this.setState('listening');
    }
  }

  async interrupt(): Promise<void> {
    this.engines.tts.stop();
    this.setState('listening');
  }

  setMicEnabled(on: boolean): void {
    this.micEnabled = on;
  }

  async recycleSession(): Promise<void> {
    // Nothing to recycle in a local pipeline (no cloud session cap).
  }
}
