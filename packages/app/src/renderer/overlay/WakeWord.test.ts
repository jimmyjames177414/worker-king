import { describe, it, expect } from 'vitest';
import {
  FrameChunker,
  NullWakeWordDetector,
  createWakeWordDetector,
  shouldWakeListen,
  WAKE_TAP_WORKLET_SOURCE,
  type WakeWordDetector,
} from './WakeWord.js';

describe('FrameChunker', () => {
  it('emits fixed-size frames and buffers the remainder across pushes', () => {
    const chunker = new FrameChunker(4);
    expect(chunker.push(Float32Array.from([1, 2, 3]))).toEqual([]); // not enough yet
    const frames = chunker.push(Float32Array.from([4, 5, 6, 7, 8]));
    expect(frames).toHaveLength(2);
    expect(Array.from(frames[0])).toEqual([1, 2, 3, 4]);
    expect(Array.from(frames[1])).toEqual([5, 6, 7, 8]);
  });

  it('resets its buffer', () => {
    const chunker = new FrameChunker(4);
    chunker.push(Float32Array.from([1, 2, 3]));
    chunker.reset();
    // After reset the earlier partial samples are gone.
    expect(chunker.push(Float32Array.from([9, 9, 9, 9]))).toEqual([
      Float32Array.from([9, 9, 9, 9]),
    ]);
  });
});

describe('NullWakeWordDetector', () => {
  it('never fires', () => {
    const d = new NullWakeWordDetector();
    expect(d.process()).toBe(false);
  });
});

describe('shouldWakeListen', () => {
  it('listens only when enabled and no voice session is live', () => {
    // [enabled, voiceState, expected]
    const table: Array<[boolean, string, boolean]> = [
      [true, 'idle', true],
      [true, 'error', true], // dead session: wake word is the way back in
      [true, 'listening', false],
      [true, 'thinking', false],
      [true, 'talking', false], // never let the detector hear our own TTS
      [false, 'idle', false],
      [false, 'talking', false],
    ];
    for (const [enabled, state, expected] of table) {
      expect(shouldWakeListen(enabled, state)).toBe(expected);
    }
  });
});

describe('WAKE_TAP_WORKLET_SOURCE', () => {
  it('registers the wk-tap processor and copies each block', () => {
    expect(WAKE_TAP_WORKLET_SOURCE).toContain("registerProcessor('wk-tap'");
    expect(WAKE_TAP_WORKLET_SOURCE).toContain('Float32Array.from'); // copy, not a view
  });
});

describe('createWakeWordDetector', () => {
  it('falls back to a non-firing detector when no model package is installed', async () => {
    const detector: WakeWordDetector = await createWakeWordDetector();
    expect(detector.process(new Float32Array(1280))).toBe(false);
  });
});
