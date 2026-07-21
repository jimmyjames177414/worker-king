/**
 * @workerking/wakeword-openwakeword — the real wake-word detector behind the
 * overlay's pluggable `WakeWordDetector` slot.
 *
 * Runs the standard openWakeWord streaming pipeline on 16 kHz mono frames:
 *
 *   1280-sample frame → melspectrogram.onnx → mel frames (32 bins, x/10+2 scaled)
 *     → rolling 76-frame window → embedding_model.onnx → 96-dim embedding (hop 8)
 *     → rolling 16-embedding window → wake model (e.g. computer_v2.onnx) → score
 *
 * ONNX inference is behind an injectable `OnnxSessionLike` factory so the
 * pipeline (buffering, hops, threshold, reset) is unit-testable headless; the
 * real factory wraps onnxruntime-web (WASM) and fetches the model files by URL
 * from the renderer's public assets.
 *
 * `process()` is synchronous by contract (the mic tap calls it per frame), so
 * frames feed an internal async chain and a detection latches until the next
 * `process()` call reads it — worst-case one frame (~80 ms) of extra latency.
 */

// onnxruntime-web's wasm binary + loader, resolved as build-time asset URLs
// (Vite copies/hashes them into the renderer bundle) rather than left to
// onnxruntime-web's own default resolution, which assumes the file sits next
// to wherever its own script loaded from — a path that doesn't exist once
// Vite has bundled everything, and fails with "both async and sync fetching
// of the wasm failed". These are the package's own published subpath exports
// (see its package.json "exports"), not a reach into internal dist/ layout.
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import wasmLoaderUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';

/** Matches the overlay's WakeWordDetector interface (structural). */
export interface WakeWordDetectorLike {
  process(frame: Float32Array): boolean;
  reset(): void;
}

/** Minimal ONNX session surface (real one wraps onnxruntime-web). */
export interface OnnxSessionLike {
  run(data: Float32Array, dims: number[]): Promise<{ data: Float32Array; dims: number[] }>;
}

export interface OpenWakeWordSessions {
  melspec: OnnxSessionLike;
  embedding: OnnxSessionLike;
  wake: OnnxSessionLike;
}

export interface OpenWakeWordOptions {
  /** Detection threshold on the wake model's sigmoid score. */
  threshold?: number;
  /** Frames the pipeline may buffer when inference lags realtime. */
  maxQueue?: number;
}

const MEL_BINS = 32;
const MEL_WINDOW = 76; // mel frames per embedding input
const MEL_HOP = 8; // mel frames consumed per embedding (80 ms)
const EMB_WINDOW = 16; // embeddings per wake-model input
const EMB_DIM = 96;
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_MAX_QUEUE = 50;

/**
 * Left context prepended to every melspec call, matching upstream openWakeWord's
 * `-n_samples - 160*3` slice.
 *
 * The melspec model's STFT is a conv with kernel=512, stride=160, pad=0, so it
 * emits `floor((N - 512) / 160) + 1` frames. A bare 1280-sample hop yields 5,
 * not the 8 the rest of this pipeline assumes — which silently runs everything
 * at 62.5 mel fps instead of 100, stretching the 76-frame embedding window to
 * 1.216 s of audio instead of 760 ms. The embedding model then sees speech 1.6x
 * slower than it was trained on and the wake score pins near zero forever.
 * 480 + 1280 = 1760 samples gives exactly 8 frames.
 */
const MEL_CONTEXT = 480;

/**
 * openWakeWord's melspec model is trained on 16-bit PCM (upstream flat-out
 * rejects any other dtype); Web Audio hands us floats in +/-1.0. Without this
 * the STFT magnitudes come out ~90 dB too small and the log-mels land nowhere
 * near the range the embedding model ever saw.
 */
const INT16_SCALE = 32767;

export class OpenWakeWordDetector implements WakeWordDetectorLike {
  private readonly threshold: number;
  private readonly maxQueue: number;
  private melBuffer: Float32Array[] = [];
  private embBuffer: Float32Array[] = [];
  private queue: Float32Array[] = [];
  /** Tail of the previous audio fed to melspec (see MEL_CONTEXT). Zeros on a cold start. */
  private melContext = new Float32Array(MEL_CONTEXT);
  private processing = false;
  private detected = false;
  /** Bumped by reset() so an in-flight step can't write into cleared buffers. */
  private epoch = 0;
  /** Throttles score logging to ~once/second (a score computes every ~80ms). */
  private scoreLogCounter = 0;

  constructor(
    private readonly sessions: OpenWakeWordSessions,
    opts: OpenWakeWordOptions = {},
  ) {
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    this.maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
  }

  /**
   * Feed one mono PCM frame; returns true when the wake word was detected by
   * the (async) pipeline since the previous call.
   */
  process(frame: Float32Array): boolean {
    // An empty frame is only ever a latch read (callers poll this return value),
    // and queueing one would run melspec on bare context — too short to produce
    // a single frame.
    if (frame.length) this.queue.push(frame);
    if (this.queue.length > this.maxQueue) {
      // Inference is behind realtime — drop the oldest audio, keep up.
      this.queue.splice(0, this.queue.length - this.maxQueue);
    }
    void this.drain();
    const hit = this.detected;
    this.detected = false;
    return hit;
  }

  /** Await the pipeline going idle (tests / graceful teardown). */
  async flush(): Promise<void> {
    while (this.processing || this.queue.length) await new Promise((r) => setTimeout(r, 0));
  }

  reset(): void {
    this.epoch++;
    this.queue = [];
    this.melBuffer = [];
    this.embBuffer = [];
    this.melContext = new Float32Array(MEL_CONTEXT);
    this.detected = false;
  }

  private async drain(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length) {
        const frame = this.queue.shift()!;
        const myEpoch = this.epoch;
        try {
          await this.step(frame, myEpoch);
        } catch (err) {
          // One bad inference must not kill wake listening; drop the frame.
          console.warn('[wakeword] inference step failed', err);
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async step(frame: Float32Array, myEpoch: number): Promise<void> {
    // 1. Raw samples → mel frames. The model needs MEL_CONTEXT samples of
    //    preceding audio to emit one frame per 160 samples of the new hop, and
    //    it wants int16-range PCM. Output shape is [1, 1, F, 32]; F depends on
    //    the input length, so read it from the data instead of assuming.
    const input = new Float32Array(MEL_CONTEXT + frame.length);
    input.set(this.melContext, 0);
    input.set(frame, MEL_CONTEXT);
    // Carry this call's tail forward *before* awaiting, so a reset() landing
    // mid-inference clears it (and the epoch guard below drops our result).
    this.melContext = input.slice(input.length - MEL_CONTEXT);
    const scaled = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) scaled[i] = input[i] * INT16_SCALE;
    const mel = await this.sessions.melspec.run(scaled, [1, scaled.length]);
    if (myEpoch !== this.epoch) return;
    const melFrames = mel.data.length / MEL_BINS;
    for (let i = 0; i < melFrames; i++) {
      const row = new Float32Array(MEL_BINS);
      for (let j = 0; j < MEL_BINS; j++) {
        // openWakeWord's documented scaling for the shared melspec model.
        row[j] = mel.data[i * MEL_BINS + j] / 10 + 2;
      }
      this.melBuffer.push(row);
    }

    // 2. Enough mel context → embeddings (hop 8 frames = one per 80 ms chunk).
    while (this.melBuffer.length >= MEL_WINDOW) {
      const window = new Float32Array(MEL_WINDOW * MEL_BINS);
      for (let i = 0; i < MEL_WINDOW; i++) window.set(this.melBuffer[i], i * MEL_BINS);
      const emb = await this.sessions.embedding.run(window, [1, MEL_WINDOW, MEL_BINS, 1]);
      if (myEpoch !== this.epoch) return;
      this.embBuffer.push(Float32Array.from(emb.data.slice(0, EMB_DIM)));
      this.melBuffer.splice(0, MEL_HOP);
      if (this.embBuffer.length > EMB_WINDOW) {
        this.embBuffer.splice(0, this.embBuffer.length - EMB_WINDOW);
      }

      // 3. Enough embeddings → wake-model score.
      if (this.embBuffer.length === EMB_WINDOW) {
        const features = new Float32Array(EMB_WINDOW * EMB_DIM);
        for (let i = 0; i < EMB_WINDOW; i++) features.set(this.embBuffer[i], i * EMB_DIM);
        const score = await this.sessions.wake.run(features, [1, EMB_WINDOW, EMB_DIM]);
        if (myEpoch !== this.epoch) return;
        // Without this, a silently-never-firing detector is indistinguishable
        // from "no audio reaching the model" or "model loaded but scores are
        // always ~0" — both look identical (nothing happens) from outside.
        // Throttled to ~once/sec; a near-miss (close to threshold but under)
        // logs immediately so it isn't missed between throttled ticks.
        const nearMiss = score.data[0] >= this.threshold * 0.5;
        if (nearMiss || ++this.scoreLogCounter % 12 === 0) {
          console.debug(`[wakeword] score=${score.data[0].toFixed(3)} threshold=${this.threshold}`);
        }
        if (score.data[0] >= this.threshold) {
          this.detected = true;
          // Refractory: clear context so one utterance can't re-trigger.
          this.melBuffer = [];
          this.embBuffer = [];
          this.queue = [];
          return;
        }
      }
    }
  }
}

export interface CreateDetectorOptions extends OpenWakeWordOptions {
  /** URL of the wake-word classifier model (e.g. "wakewords/computer_v2.onnx"). */
  wakeModelUrl: string;
  melspecUrl: string;
  embeddingUrl: string;
  /** Override the ONNX session factory (tests / alternative runtimes). */
  createSession?: (url: string) => Promise<OnnxSessionLike>;
}

/** Load the three models and build a ready detector. Throws if anything fails. */
export async function createDetector(opts: CreateDetectorOptions): Promise<OpenWakeWordDetector> {
  const make = opts.createSession ?? createOrtWebSession;
  const [melspec, embedding, wake] = await Promise.all([
    make(opts.melspecUrl),
    make(opts.embeddingUrl),
    make(opts.wakeModelUrl),
  ]);
  return new OpenWakeWordDetector(
    { melspec, embedding, wake },
    { threshold: opts.threshold, maxQueue: opts.maxQueue },
  );
}

let ortWasmPathsConfigured = false;

/** The real factory: onnxruntime-web (WASM) over a fetched model file. */
async function createOrtWebSession(url: string): Promise<OnnxSessionLike> {
  const ort = await import('onnxruntime-web');
  if (!ortWasmPathsConfigured) {
    ortWasmPathsConfigured = true;
    ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmLoaderUrl };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`wake model fetch failed: ${res.status} ${url}`);
  const buf = await res.arrayBuffer();
  const session = await ort.InferenceSession.create(buf);
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  return {
    async run(data, dims) {
      const out = await session.run({ [inputName]: new ort.Tensor('float32', data, dims) });
      const t = out[outputName];
      return { data: t.data as Float32Array, dims: t.dims as number[] };
    },
  };
}
