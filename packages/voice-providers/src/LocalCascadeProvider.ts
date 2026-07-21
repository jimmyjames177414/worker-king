import { sanitizeForSpeech } from '@workerking/shared';
import type { VoiceProvider, VoiceProviderState, VoiceStartOptions } from './VoiceProvider.js';

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

/** A synthesized utterance, ready to play. */
export interface TtsClip {
  /** Play the clip; resolves when playback finishes (or was invalidated). */
  play(): Promise<void>;
}

/**
 * Text-to-speech. Synthesis and playback are separate stages so the provider
 * can synthesize sentence N+1 while sentence N is still playing (pipelining) —
 * otherwise every inter-sentence gap costs a full synthesis.
 */
export interface TtsEngine {
  /** Synthesize `text` into a playable clip. Safe to call concurrently. */
  synthesize(text: string): Promise<TtsClip>;
  /** Stop any in-progress playback and invalidate pending clips (barge-in). */
  stop(): void;
}

export interface BargeInOptions {
  /**
   * While the assistant is talking, mic speech must sustain this long before it
   * counts as a barge-in. Filters echo blips of our own TTS that survive AEC.
   */
  sustainedMs?: number;
  /** A completed utterance shorter than this (while talking) is dropped as echo. */
  minUtteranceMs?: number;
}

export interface LocalCascadeOptions {
  vad: VadEngine;
  stt: SttEngine;
  tts: TtsEngine;
  bargeIn?: BargeInOptions;
}

const DEFAULT_SUSTAINED_MS = 300;
const DEFAULT_MIN_UTTERANCE_MS = 350;
const VAD_SAMPLE_RATE = 16000;

export class LocalCascadeProvider implements VoiceProvider {
  readonly id = 'local-cascade' as const;
  private startOpts?: VoiceStartOptions;
  private state: VoiceProviderState = 'idle';
  private running = false;
  private micEnabled = true;
  /** Bumped whenever the VAD is (re)started or released — deadens stale taps. */
  private micEpoch = 0;
  /** Serializes utterance → STT so rapid utterances can't finish out of order. */
  private sttChain: Promise<void> = Promise.resolve();
  /** Serializes clip playback; synthesis runs ahead of this queue. */
  private playChain: Promise<void> = Promise.resolve();
  /** Monotonic id per spoken utterance, so a superseded one can't clobber state. */
  private speakSeq = 0;
  /** Armed on speech-start while talking; fires = sustained speech = real barge-in. */
  private bargeTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly engines: LocalCascadeOptions) {}

  private get bargeCfg(): Required<BargeInOptions> {
    return {
      sustainedMs: this.engines.bargeIn?.sustainedMs ?? DEFAULT_SUSTAINED_MS,
      minUtteranceMs: this.engines.bargeIn?.minUtteranceMs ?? DEFAULT_MIN_UTTERANCE_MS,
    };
  }

  async start(opts: VoiceStartOptions): Promise<void> {
    this.startOpts = opts;
    this.running = true;
    await this.startVad();
    this.setState('listening');
  }

  private async startVad(): Promise<void> {
    const myEpoch = ++this.micEpoch;
    await this.engines.vad.start(
      (pcm) => {
        if (myEpoch === this.micEpoch) this.onUtteranceEnd(pcm);
      },
      () => {
        if (myEpoch === this.micEpoch) this.onSpeechStartSignal();
      },
    );
  }

  /** The mic heard speech begin. */
  private onSpeechStartSignal(): void {
    // Ignore while muted or stopped so muting truly silences the mic.
    if (!this.running || !this.micEnabled) return;
    if (this.state === 'talking') {
      // Half-duplex guard: while we're talking, "speech" may be our own TTS
      // leaking past echo cancellation. Hold fire until it sustains; a blip
      // that ends early is judged by length in onUtteranceEnd.
      if (this.bargeTimer !== undefined) return;
      this.bargeTimer = setTimeout(() => {
        this.bargeTimer = undefined;
        this.doBargeIn();
      }, this.bargeCfg.sustainedMs);
      return;
    }
    this.doBargeIn();
  }

  /** Real user speech: cut TTS, tell the host to drop stale replies, listen. */
  private doBargeIn(): void {
    this.engines.tts.stop();
    this.startOpts?.delegate.onSpeechStart?.();
    this.setState('listening');
  }

  /** The mic heard speech end; `pcm` is the captured utterance. */
  private onUtteranceEnd(pcm: Float32Array): void {
    if (!this.running || !this.micEnabled) return;
    if (this.bargeTimer !== undefined) {
      // Speech ended inside the sustain window — echo blip or a real (short)
      // interjection? Decide by utterance length.
      clearTimeout(this.bargeTimer);
      this.bargeTimer = undefined;
      const ms = (pcm.length / VAD_SAMPLE_RATE) * 1000;
      if (ms < this.bargeCfg.minUtteranceMs) return; // echo — TTS keeps playing
      this.doBargeIn();
    }
    // Serialize STT: two quick utterances must produce transcripts in order,
    // even when the first transcription is slower than the second.
    this.sttChain = this.sttChain
      .then(() => this.processUtterance(pcm))
      .catch((err) => console.error('[voice] stt chain', err));
  }

  private async processUtterance(pcm: Float32Array): Promise<void> {
    if (!this.running || !this.micEnabled) return;
    this.setState('thinking');
    const t0 = Date.now();
    try {
      const text = await this.engines.stt.transcribe(pcm);
      // Stage timing (N7): composes with VoiceHost's turn-latency line into a
      // full stt → first_token → tts breakdown in the log runner.
      const audioSecs = (pcm.length / VAD_SAMPLE_RATE).toFixed(1);
      console.log(`[voice] stt latency: ${Date.now() - t0}ms for ${audioSecs}s audio`);
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
    this.micEpoch++; // deaden any stale VAD tap
    if (this.bargeTimer !== undefined) {
      clearTimeout(this.bargeTimer);
      this.bargeTimer = undefined;
    }
    this.engines.vad.stop();
    this.engines.tts.stop();
    this.setState('idle');
  }

  /**
   * Speak assistant text (the brain's reply, or a progress update).
   *
   * Synthesis starts immediately so it overlaps the playback of any earlier
   * sentence; only playback is serialized (the play chain). That keeps
   * inter-sentence gaps at ~0 instead of one synthesis each. Resolves when this
   * clip finishes playing.
   */
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
    const t0 = Date.now();
    // Kick off synthesis now — a barge-in invalidates the clip engine-side.
    const clipPromise = this.engines.tts.synthesize(spoken).then(
      (clip) => {
        console.log(`[voice] tts synth: ${Date.now() - t0}ms for ${spoken.length} chars`);
        return clip;
      },
      (err) => {
        this.startOpts?.delegate.onError(err instanceof Error ? err : new Error(String(err)));
        return undefined;
      },
    );
    const turn = this.playChain.then(async () => {
      const clip = await clipPromise;
      try {
        if (clip && this.running) await clip.play();
      } finally {
        // Only the *latest* utterance resets state — and never while a newer
        // STT already moved us to 'thinking' (the state-flap).
        if (this.running && seq === this.speakSeq && this.state === 'talking') {
          this.setState('listening');
        }
      }
    });
    this.playChain = turn.catch(() => {});
    await turn;
  }

  async interrupt(): Promise<void> {
    if (this.bargeTimer !== undefined) {
      clearTimeout(this.bargeTimer);
      this.bargeTimer = undefined;
    }
    this.engines.tts.stop();
    this.setState('listening');
  }

  setMicEnabled(on: boolean): void {
    if (on === this.micEnabled) return;
    this.micEnabled = on;
    if (!this.running) return;
    if (!on) {
      // Release the capture entirely (OS mic indicator goes off), not just a
      // soft gate — re-acquisition on unmute is cheap for a local mic.
      this.micEpoch++;
      this.engines.vad.stop();
    } else {
      void this.startVad().catch((err) => {
        this.setState('error');
        this.startOpts?.delegate.onError(err instanceof Error ? err : new Error(String(err)));
      });
    }
  }

  async recycleSession(): Promise<void> {
    // Nothing to recycle in a local pipeline (no cloud session cap).
  }

  updateInstructions(systemPrompt: string): void {
    // The local cascade reads the prompt fresh from startOpts each turn, so just
    // update the stored base; there's no standing cloud session to patch.
    if (this.startOpts) this.startOpts = { ...this.startOpts, systemPrompt };
  }
}
