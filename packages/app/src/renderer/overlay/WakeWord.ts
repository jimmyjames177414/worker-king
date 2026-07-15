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
 * Build the active wake-word detector. Tries an optional openWakeWord adapter
 * (onnxruntime-web + a "hey jarvis"/custom model) via dynamic import — the same
 * optional-dependency pattern the local-voice engines use — and falls back to a
 * detector that never fires when it isn't installed. So enabling the feature
 * without a model is a safe no-op rather than a crash; dropping the model in is
 * the remaining Windows+mic step, with no code change here.
 */
export async function createWakeWordDetector(): Promise<WakeWordDetector> {
  try {
    // Indirect specifier so the optional package isn't a static build/typecheck dep.
    const mod = (await optionalImport('@workerking/wakeword-openwakeword')) as {
      createDetector(): WakeWordDetector;
    };
    return mod.createDetector();
  } catch {
    return new NullWakeWordDetector();
  }
}

/** Import an optional package by name; the variable specifier keeps it off the build graph. */
function optionalImport(name: string): Promise<unknown> {
  return import(/* @vite-ignore */ name);
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

export class WakeWordController {
  private stream?: MediaStream;
  private ctx?: AudioContext;
  private node?: ScriptProcessorNode;
  private enabled = false;
  private readonly chunker = new FrameChunker(FRAME_SIZE);

  constructor(
    private readonly detector: WakeWordDetector,
    private readonly onWake: () => void,
  ) {}

  isEnabled(): boolean {
    return this.enabled;
  }

  async enable(inputDeviceId?: string): Promise<void> {
    if (this.enabled) return;
    this.enabled = true;
    this.detector.reset();
    this.chunker.reset();

    this.stream = await navigator.mediaDevices.getUserMedia(audioInputConstraints(inputDeviceId));
    // 16 kHz to match wake-word models.
    this.ctx = new AudioContext({ sampleRate: 16000 });
    const source = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessorNode is deprecated but the simplest raw-frame tap; an
    // AudioWorklet is the upgrade if this proves too jittery.
    this.node = this.ctx.createScriptProcessor(2048, 1, 1);
    this.node.onaudioprocess = (e) => this.onAudio(e.inputBuffer.getChannelData(0));
    source.connect(this.node);
    this.node.connect(this.ctx.destination);
  }

  private onAudio(input: Float32Array): void {
    // Re-chunk the mic buffer into FRAME_SIZE frames for the detector.
    for (const frame of this.chunker.push(input)) {
      if (this.detector.process(frame)) {
        this.detector.reset();
        this.chunker.reset();
        this.onWake();
        return;
      }
    }
  }

  disable(): void {
    this.enabled = false;
    this.node?.disconnect();
    this.node = undefined;
    void this.ctx?.close();
    this.ctx = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.chunker.reset();
  }
}
