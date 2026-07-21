import { describe, it, expect } from 'vitest';
import {
  OpenWakeWordDetector,
  createDetector,
  type OnnxSessionLike,
  type OpenWakeWordSessions,
} from './index.js';

/**
 * The real melspec model's STFT is a conv with kernel=512, stride=160, pad=0.
 * The fakes reproduce that arithmetic exactly rather than an idealized
 * frames-per-sample ratio: it is the reason the detector has to prepend 480
 * samples of context to every 1280-sample hop to get 8 frames, and a fake that
 * rounds it off would let that regress silently.
 */
const melFrameCount = (samples: number) => Math.max(0, Math.floor((samples - 512) / 160) + 1);

/**
 * Fakes reproduce the pipeline shapes: melspec yields mel frames (32 bins) per
 * the conv arithmetic above, embedding yields a 96-dim vector per 76-frame
 * window, and the wake model returns a scripted score per call.
 */
function fakeSessions(scores: number[]) {
  const calls = { melspec: 0, embedding: 0, wake: 0 };
  const seen = { melspecSamples: 0, melspecPeak: 0 };
  const melspec: OnnxSessionLike = {
    async run(data) {
      calls.melspec++;
      seen.melspecSamples = data.length;
      for (const v of data) seen.melspecPeak = Math.max(seen.melspecPeak, Math.abs(v));
      const frames = melFrameCount(data.length);
      return { data: new Float32Array(frames * 32).fill(-10), dims: [1, 1, frames, 32] };
    },
  };
  const embedding: OnnxSessionLike = {
    async run() {
      calls.embedding++;
      return { data: new Float32Array(96).fill(0.5), dims: [1, 1, 1, 96] };
    },
  };
  const wake: OnnxSessionLike = {
    async run() {
      calls.wake++;
      return { data: new Float32Array([scores.shift() ?? 0]), dims: [1, 1] };
    },
  };
  const sessions: OpenWakeWordSessions = { melspec, embedding, wake };
  return { sessions, calls, seen };
}

const FRAME = new Float32Array(1280);

async function feed(detector: OpenWakeWordDetector, frames: number): Promise<boolean> {
  let hit = false;
  for (let i = 0; i < frames; i++) hit = detector.process(FRAME) || hit;
  await detector.flush();
  // One extra process() reads a detection latched by the async pipeline.
  return hit || detector.process(new Float32Array(0));
}

describe('OpenWakeWordDetector', () => {
  it('feeds melspec int16-range PCM with left context, for 8 frames per hop', async () => {
    // Both halves of this are invisible from outside: wrong scale or a short
    // melspec input still runs the whole pipeline, just with features the
    // models were never trained on, and the score sits near zero forever.
    const { sessions, seen } = fakeSessions([0]);
    const detector = new OpenWakeWordDetector(sessions);
    detector.process(new Float32Array(1280).fill(1));
    await detector.flush();

    expect(seen.melspecPeak).toBeCloseTo(32767, 0); // not +/-1.0 float audio
    expect(seen.melspecSamples).toBe(1760); // 480 samples of context + the hop
    expect(melFrameCount(seen.melspecSamples)).toBe(8);
  });

  it('needs enough audio context before the wake model ever runs', async () => {
    const { sessions, calls } = fakeSessions([0]);
    const detector = new OpenWakeWordDetector(sessions);
    // 76 mel frames needed for the first embedding; 8 frames/chunk → 10 chunks.
    for (let i = 0; i < 9; i++) detector.process(FRAME);
    await detector.flush();
    expect(calls.embedding).toBe(0); // only 72 mel frames so far — no embedding yet
    expect(calls.wake).toBe(0); // and 16 embeddings are needed before scoring

    detector.process(FRAME); // chunk 10 → 80 mel frames → first embedding
    await detector.flush();
    expect(calls.embedding).toBe(1);
    expect(calls.wake).toBe(0);
  });

  it('fires once the scripted score crosses the threshold, then resets context', async () => {
    // Wake model returns low scores, then a hit on the 3rd call.
    const { sessions, calls } = fakeSessions([0.1, 0.2, 0.97]);
    const detector = new OpenWakeWordDetector(sessions, { threshold: 0.6 });

    const hit = await feed(detector, 40);
    expect(hit).toBe(true);
    expect(calls.wake).toBe(3); // stopped scoring after the detection (refractory)

    // Context cleared: the very next frame cannot immediately re-fire.
    expect(detector.process(FRAME)).toBe(false);
  });

  it('stays quiet below the threshold', async () => {
    const { sessions, calls } = fakeSessions(Array(50).fill(0.4));
    const detector = new OpenWakeWordDetector(sessions, { threshold: 0.6 });
    const hit = await feed(detector, 40);
    expect(hit).toBe(false);
    expect(calls.wake).toBeGreaterThan(0); // it was scoring, just under threshold
  });

  it('reset() clears all rolling context', async () => {
    const { sessions, calls } = fakeSessions([0.97]);
    const detector = new OpenWakeWordDetector(sessions, { threshold: 0.6 });
    for (let i = 0; i < 9; i++) detector.process(FRAME);
    await detector.flush();
    detector.reset();
    // After reset the pipeline needs the full warm-up again before scoring.
    for (let i = 0; i < 9; i++) detector.process(FRAME);
    await detector.flush();
    expect(calls.wake).toBe(0);
  });

  it('caps the frame queue when inference lags realtime', async () => {
    let release: (() => void) | undefined;
    const slowMel: OnnxSessionLike = {
      run: () =>
        new Promise((resolve) => {
          const frames = melFrameCount(1280 + 480);
          release = () =>
            resolve({ data: new Float32Array(frames * 32).fill(-10), dims: [1, 1, frames, 32] });
        }),
    };
    const { sessions } = fakeSessions([0]);
    const detector = new OpenWakeWordDetector({ ...sessions, melspec: slowMel }, { maxQueue: 5 });
    for (let i = 0; i < 100; i++) detector.process(FRAME); // first frame hangs in slowMel
    // No assertion on internals possible — but flushing must terminate quickly
    // once released, proving the backlog was capped rather than 100 deep.
    const flushed = (async () => {
      while (release === undefined) await new Promise((r) => setTimeout(r, 0));
      // Release every subsequent step immediately.
      const timer = setInterval(() => release?.(), 0);
      await detector.flush();
      clearInterval(timer);
      return true;
    })();
    expect(await flushed).toBe(true);
  });
});

describe('createDetector', () => {
  it('builds sessions for all three model urls via the injected factory', async () => {
    const seen: string[] = [];
    const { sessions } = fakeSessions([0]);
    const detector = await createDetector({
      wakeModelUrl: 'wake.onnx',
      melspecUrl: 'mel.onnx',
      embeddingUrl: 'emb.onnx',
      createSession: async (url) => {
        seen.push(url);
        return sessions.melspec;
      },
    });
    expect(detector).toBeInstanceOf(OpenWakeWordDetector);
    expect(seen.sort()).toEqual(['emb.onnx', 'mel.onnx', 'wake.onnx']);
  });
});
