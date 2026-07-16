import {
  LocalCascadeProvider,
  type VadEngine,
  type SttEngine,
  type TtsEngine,
} from './LocalCascadeProvider.js';

/**
 * localEngines — the real (offline) STT/VAD/TTS adapters for the local cascade.
 *
 * These are the documented drop-in (Phase 5.3): a fully-JS pipeline that runs in
 * the Electron renderer with no Python — VAD via `@ricky0123/vad-web` (Silero),
 * STT via `@huggingface/transformers` (Whisper onnx), TTS via `kokoro-js`
 * (Kokoro-82M). They're OPTIONAL: the libs are dynamically imported so they aren't
 * build/runtime deps until the user opts into local voice, and each adapter throws
 * a clear "install X" error if the lib/model isn't present. Models download on
 * first use. (Swap in a Python faster-whisper sidecar for GPU speed — same
 * interfaces.)
 *
 * The orchestration these feed (LocalCascadeProvider) is verified with fakes; the
 * real audio path is a Windows/GPU manual check.
 */

async function optionalImport(name: string): Promise<unknown> {
  try {
    // Vite/electron: don't try to bundle these optional deps.
    return await import(/* @vite-ignore */ name);
  } catch {
    throw new Error(
      `Local voice needs "${name}". Install it to enable offline voice: pnpm add ${name}`,
    );
  }
}

/** Silero VAD in the browser via @ricky0123/vad-web. */
export class BrowserVadEngine implements VadEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mic?: any;
  async start(onUtterance: (pcm: Float32Array) => void, onSpeechStart?: () => void): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vad = (await optionalImport('@ricky0123/vad-web')) as any;
    this.mic = await vad.MicVAD.new({
      onSpeechStart: () => onSpeechStart?.(),
      onSpeechEnd: (audio: Float32Array) => onUtterance(audio),
    });
    this.mic.start();
  }
  stop(): void {
    this.mic?.pause?.();
    this.mic = undefined;
  }
}

/** Whisper STT via @huggingface/transformers (onnxruntime-web). */
export class WhisperSttEngine implements SttEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipe?: any;
  constructor(private readonly model = 'onnx-community/whisper-base') {}
  async transcribe(pcm: Float32Array): Promise<string> {
    if (!this.pipe) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = (await optionalImport('@huggingface/transformers')) as any;
      this.pipe = await t.pipeline('automatic-speech-recognition', this.model);
    }
    const out = await this.pipe(pcm, { sampling_rate: 16000 });
    return String(out?.text ?? '').trim();
  }
}

/** Kokoro-82M TTS via kokoro-js, played through the WebAudio API. */
export class KokoroTtsEngine implements TtsEngine {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private tts?: any;
  private ctx?: AudioContext;
  /** All sources currently playing — concurrent speak()s must all be stoppable. */
  private readonly sources = new Set<AudioBufferSourceNode>();
  /**
   * Barge-in epoch: stop() bumps it, and any speak() still awaiting synthesis
   * checks it before playing. Without this, a sentence mid-`generate()` when
   * the user barges in would start talking over them once synthesis resolves.
   */
  private epoch = 0;
  constructor(private readonly voiceId = 'af_heart') {}
  async speak(text: string): Promise<void> {
    const started = this.epoch;
    if (!this.tts) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const k = (await optionalImport('kokoro-js')) as any;
      this.tts = await k.KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-ONNX');
    }
    if (this.epoch !== started) return; // barged in while loading
    const audio = await this.tts.generate(text, { voice: this.voiceId });
    if (this.epoch !== started) return; // barged in while synthesizing
    const { audio: samples, sampling_rate } = audio; // Float32 PCM + rate
    this.ctx ??= new AudioContext();
    const buffer = this.ctx.createBuffer(1, samples.length, sampling_rate);
    buffer.getChannelData(0).set(samples);
    await new Promise<void>((resolve) => {
      const src = this.ctx!.createBufferSource();
      this.sources.add(src);
      src.buffer = buffer;
      src.connect(this.ctx!.destination);
      src.onended = () => {
        this.sources.delete(src);
        resolve();
      };
      src.start();
    });
  }
  stop(): void {
    this.epoch++;
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
  }
}

/** Build a LocalCascadeProvider backed by the real offline engines. */
export function createLocalCascadeProvider(opts?: {
  whisperModel?: string;
  kokoroVoice?: string;
}): LocalCascadeProvider {
  return new LocalCascadeProvider({
    vad: new BrowserVadEngine(),
    stt: new WhisperSttEngine(opts?.whisperModel),
    tts: new KokoroTtsEngine(opts?.kokoroVoice),
  });
}
