/**
 * WakeWord — opt-in "Hey <name>" hands-free activation (Phase 2.3).
 *
 * Architecture is complete and wired; the detector is pluggable. The default
 * NullWakeWordDetector never fires (safe: the feature is a no-op until a real
 * model is installed). Dropping in an openWakeWord-backed detector
 * (onnxruntime-web + the melspectrogram + "hey jarvis"/custom model) is the one
 * remaining step, and it needs a Windows machine + mic to verify — hence it isn't
 * wired to untested inference here.
 *
 * When enabled (config `wakeWordEnabled`), the controller opens the mic and feeds
 * mono PCM frames to the detector; a detected wake calls `onWake`, which triggers
 * the same voice-session start as the push-to-talk hotkey.
 */

import { audioInputConstraints } from '../shared/audioDevices.js';
import { describeError } from '../shared/describeError.js';
import { fmt } from '../shared/rendererLog.js';

export interface WakeWordDetector {
  /**
   * Feed one mono PCM frame (Float32, typically 1280 samples @ 16 kHz for
   * openWakeWord). Return true when the wake word is detected.
   */
  process(frame: Float32Array): boolean;
  reset(): void;
}

/** Default: never fires. Replaced by an openWakeWord detector on Windows. */
export class NullWakeWordDetector implements WakeWordDetector {
  process(): boolean {
    return false;
  }
  reset(): void {
    /* no-op */
  }
}

/**
 * The active wake word: the community openWakeWord "computer" model (v2 also
 * reacts to "hey computer"), served from the renderer's public assets alongside
 * openWakeWord's shared melspectrogram + embedding models.
 *
 * Threshold note: this model benchmarks at ~5 false activations/hour at its
 * default cutoff, so we run it hot (0.6) — and wake is start-only + suspended
 * during sessions, so a false fire while idle costs one listening chime, never
 * an interruption.
 */
// Paths are relative to this page (overlay/index.html), not the site/app root:
// `public/wakewords/*.onnx` is served (dev) / copied (build) to the *renderer
// root*, a sibling of `overlay/` — not nested under it. A bare 'wakewords/...'
// resolves under the page's own path (.../overlay/wakewords/...) and 404s in
// both dev (vite) and prod (file://); '../wakewords/...' correctly climbs from
// overlay/ to the renderer root in both.
const WAKE_MODELS = {
  wakeModelUrl: '../wakewords/computer_v2.onnx',
  melspecUrl: '../wakewords/melspectrogram.onnx',
  embeddingUrl: '../wakewords/embedding_model.onnx',
  threshold: 0.6,
};

/**
 * Build the active wake-word detector: the openWakeWord adapter package running
 * the "computer" model over onnxruntime-web. Falls back to a detector that
 * never fires when models/runtime can't load (headless tests, missing assets,
 * packaged file:// where fetch is unavailable) — enabling the feature can
 * degrade, never crash.
 */
export async function createWakeWordDetector(): Promise<WakeWordDetector> {
  const t0 = performance.now();
  try {
    const mod = await import('@workerking/wakeword-openwakeword');
    const detector = await mod.createDetector(WAKE_MODELS);
    // The single most important wake-word log line: a NullWakeWordDetector and
    // a working one are indistinguishable from outside (both are silent), so
    // "the wake word does nothing" can't be diagnosed without knowing which
    // one is installed. Timed too — model load is seconds, and the mic can't
    // open until it finishes.
    console.info(
      '[wake] detector ready (openWakeWord)',
      fmt({ ms: Math.round(performance.now() - t0), threshold: WAKE_MODELS.threshold }),
    );
    return detector;
  } catch (err) {
    // Plain ASCII, not an em dash: a Windows console/terminal not set to the
    // UTF-8 codepage (the common default) renders "—" as garbled "ΓÇö" mojibake.
    //
    // The model URLs are in the message on purpose: the common failure is a
    // fetch 404/blocked scheme, and knowing which URL was tried is the whole
    // diagnosis. (A packaged build loads the page over file://, where fetch is
    // unavailable — that failure lands here and disables the feature silently.)
    console.warn(
      '[wake] detector unavailable - wake word disabled',
      fmt({
        ms: Math.round(performance.now() - t0),
        // Guarded: this path also runs under the headless test env, which has
        // no `location`. In the app it's the key signal — an http:// page is
        // the dev server (fetch works), a file:// page is a packaged build
        // (fetch is blocked, which is itself the cause of landing here).
        pageUrl: globalThis.location?.href ?? '(no location)',
        models: WAKE_MODELS,
        error: describeError(err),
      }),
    );
    return new NullWakeWordDetector();
  }
}

const FRAME_SIZE = 1280; // openWakeWord's expected hop @ 16 kHz

/**
 * Accumulates arbitrary-length audio input and emits fixed-size frames. The mic
 * tap delivers ~2048-sample buffers, but wake-word models expect a specific hop
 * (1280 @ 16 kHz), so samples must be re-chunked across buffer boundaries.
 */
export class FrameChunker {
  private buffer: number[] = [];
  constructor(private readonly frameSize: number) {}

  /** Push input samples; return any complete frames now available. */
  push(input: Float32Array): Float32Array[] {
    for (let i = 0; i < input.length; i++) this.buffer.push(input[i]);
    const frames: Float32Array[] = [];
    while (this.buffer.length >= this.frameSize) {
      frames.push(Float32Array.from(this.buffer.splice(0, this.frameSize)));
    }
    return frames;
  }

  reset(): void {
    this.buffer = [];
  }
}

/**
 * Wake listening policy: the wake mic runs only when the feature is enabled AND
 * no voice session is live. Suspending during a session prevents a second open
 * mic capture and the detector hearing the assistant's own TTS.
 */
export function shouldWakeListen(
  wakeWordEnabled: boolean,
  voiceState: 'idle' | 'listening' | 'thinking' | 'talking' | 'error' | string,
): boolean {
  const voiceActive =
    voiceState === 'listening' || voiceState === 'thinking' || voiceState === 'talking';
  return wakeWordEnabled && !voiceActive;
}

/**
 * AudioWorklet processor source for the mic tap (registered via a Blob URL so no
 * separate asset ships). Posts a *copy* of each mono input block over the port —
 * the underlying buffer is recycled by the audio thread.
 */
export const WAKE_TAP_WORKLET_SOURCE = `
class WkTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(Float32Array.from(ch));
    return true;
  }
}
registerProcessor('wk-tap', WkTap);
`;

export class WakeWordController {
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private node?: ScriptProcessorNode;
  private workletNode?: AudioWorkletNode;
  private enabled = false;
  private readonly chunker = new FrameChunker(FRAME_SIZE);

  constructor(
    private readonly detector: WakeWordDetector,
    private readonly onWake: () => void,
  ) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Bumped by disable(); an enable() still awaiting the mic must tear down. */
  private enableEpoch = 0;

  /** Set on the first onAudio() call after enable(), then never logged again. */
  private sawFirstFrame = false;

  async enable(inputDeviceId?: string): Promise<void> {
    if (this.enabled) return;
    this.enabled = true;
    const myEnable = ++this.enableEpoch;
    this.sawFirstFrame = false;
    const constraints = audioInputConstraints(inputDeviceId);
    // The constraint object, not just the id: `audioInputConstraints` turns a
    // set id into `{deviceId: {exact: id}}`, and an `exact` match against a
    // stale id is the difference between "opens the default mic" and
    // "OverconstrainedError". `unset` is explicit so an absent id can never be
    // confused with the literal device id "default".
    console.debug(
      '[wake] enable: requesting mic',
      fmt({ inputDeviceId: inputDeviceId ?? '(unset)', constraints }),
    );
    this.detector.reset();
    this.chunker.reset();

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      // Enumerate on failure so the log answers "which mics did the renderer
      // actually see" — the only way to tell a stale configured id apart from
      // a renderer that can see no input devices at all (a permissions or
      // Electron-window problem, needing a completely different fix).
      await this.logInputDevices();
      this.enabled = false;
      throw err;
    }
    // disable() (or a newer enable, e.g. a device switch) won the race while we
    // awaited the mic: releasing the just-acquired stream here is what keeps
    // the mic indicator honest — assigning it would orphan a live tap.
    if (myEnable !== this.enableEpoch || !this.enabled) {
      console.debug('[wake] enable: superseded while awaiting mic, releasing stream');
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    console.debug(
      `[wake] enable: mic acquired (track=${stream.getAudioTracks()[0]?.label ?? '?'})`,
    );
    this.stream = stream;
    // 16 kHz to match wake-word models.
    this.ctx = new AudioContext({ sampleRate: 16000 });
    // Prefer an AudioWorklet tap (off-main-thread, not deprecated); fall back
    // to ScriptProcessorNode where audioWorklet is unavailable.
    if (this.ctx.audioWorklet) {
      const blobUrl = URL.createObjectURL(
        new Blob([WAKE_TAP_WORKLET_SOURCE], { type: 'application/javascript' }),
      );
      try {
        await this.ctx.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      // disable() (or a newer enable) won while addModule awaited.
      if (myEnable !== this.enableEpoch || !this.enabled) return;
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.workletNode = new AudioWorkletNode(this.ctx, 'wk-tap');
      this.workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => this.onAudio(e.data);
      source.connect(this.workletNode);
      console.debug('[wake] listening via AudioWorklet');
    } else {
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.node = this.ctx.createScriptProcessor(2048, 1, 1);
      this.node.onaudioprocess = (e) => this.onAudio(e.inputBuffer.getChannelData(0));
      source.connect(this.node);
      this.node.connect(this.ctx.destination);
      console.debug('[wake] listening via ScriptProcessorNode (no audioWorklet)');
    }
  }

  /**
   * Log every audio input the renderer can see. Labels are empty until some
   * mic permission has been granted, so an all-blank list is itself the signal
   * that the permission, not the device choice, is what failed.
   */
  private async logInputDevices(): Promise<void> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices
        .filter((d) => d.kind === 'audioinput')
        .map((d) => ({ deviceId: d.deviceId, label: d.label || '(no label)' }));
      console.warn('[wake] audio inputs visible to the renderer', fmt({ count: inputs.length, inputs }));
    } catch (err) {
      console.warn('[wake] could not enumerate audio inputs', fmt({ error: describeError(err) }));
    }
  }

  private onAudio(input: Float32Array): void {
    if (!this.sawFirstFrame) {
      // Proof audio is actually flowing into the detector — logged once so it
      // doesn't spam (frames arrive every ~80ms). Its absence after "listening
      // via ..." means the tap wired up but no audio is reaching it (wrong
      // input device, muted mic, or the worklet/processor never firing).
      this.sawFirstFrame = true;
      console.debug('[wake] first audio frame received');
    }
    // Re-chunk the mic buffer into FRAME_SIZE frames for the detector.
    for (const frame of this.chunker.push(input)) {
      if (this.detector.process(frame)) {
        console.info('[wake] wake word detected');
        this.detector.reset();
        this.chunker.reset();
        this.onWake();
        return;
      }
    }
  }

  disable(): void {
    console.debug('[wake] disable');
    this.enabled = false;
    this.enableEpoch++; // invalidate any enable() still awaiting the mic
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.port.close();
      this.workletNode.disconnect();
      this.workletNode = undefined;
    }
    this.node?.disconnect();
    this.node = undefined;
    void this.ctx?.close();
    this.ctx = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.chunker.reset();
  }
}
