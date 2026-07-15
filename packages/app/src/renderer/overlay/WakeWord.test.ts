import { describe, it, expect } from 'vitest';
import {
  FrameChunker,
  NullWakeWordDetector,
  createWakeWordDetector,
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
    expect(chunker.push(Float32Array.from([9, 9, 9, 9]))).toEqual([Float32Array.from([9, 9, 9, 9])]);
  });
});

describe('NullWakeWordDetector', () => {
  it('never fires', () => {
    const d = new NullWakeWordDetector();
    expect(d.process()).toBe(false);
  });
});

describe('createWakeWordDetector', () => {
  it('falls back to a non-firing detector when no model package is installed', async () => {
    const detector: WakeWordDetector = await createWakeWordDetector();
    expect(detector.process(new Float32Array(1280))).toBe(false);
  });
});
