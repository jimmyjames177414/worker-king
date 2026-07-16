import { describe, it, expect } from 'vitest';
import { sanitizeForSpeech, SentenceChunker } from './speech.js';

describe('sanitizeForSpeech', () => {
  it('drops <think> reasoning blocks', () => {
    expect(sanitizeForSpeech('<think>plan the answer</think>Hello there')).toBe('Hello there');
  });

  it('replaces fenced code with a spoken placeholder', () => {
    const out = sanitizeForSpeech('Try this:\n```\nrm -rf /\n```\ndone');
    expect(out).not.toContain('rm -rf');
    expect(out).toContain('code block');
  });

  it('strips emphasis and inline code markers', () => {
    expect(sanitizeForSpeech('Use **bold**, _italics_ and `code`.')).toBe(
      'Use bold, italics and code.',
    );
  });

  it('unwraps links and images to their text/alt', () => {
    expect(sanitizeForSpeech('See [the docs](https://x.y) now')).toBe('See the docs now');
    expect(sanitizeForSpeech('![a cat](cat.png)')).toBe('a cat');
  });

  it('strips headings and list markers', () => {
    const out = sanitizeForSpeech('# Title\n- one\n- two\n1. three');
    expect(out).toBe('Title\none\ntwo\nthree');
  });

  it('leaves plain text untouched', () => {
    expect(sanitizeForSpeech('Just a normal sentence.')).toBe('Just a normal sentence.');
  });
});

describe('SentenceChunker', () => {
  it('emits sentences as their boundaries arrive across chunks', () => {
    const c = new SentenceChunker();
    expect(c.push('Hello the')).toEqual([]);
    expect(c.push('re. How are ')).toEqual(['Hello there.']);
    expect(c.push('you? I am fine')).toEqual(['How are you?']);
    expect(c.flush()).toEqual(['I am fine']);
  });

  it('handles multiple sentences in one chunk', () => {
    const c = new SentenceChunker();
    expect(c.push('One. Two! Three? ')).toEqual(['One.', 'Two!', 'Three?']);
    expect(c.flush()).toEqual([]);
  });

  it('flush returns nothing when the buffer is empty', () => {
    const c = new SentenceChunker();
    c.push('Done. ');
    expect(c.flush()).toEqual([]);
  });

  it('holds boundaries inside a code fence so emitted chunks carry balanced fences', () => {
    // The streamed-voice regression: splitting on '.' inside a fence used to
    // hand sanitizeForSpeech an unpaired ``` — and the code was read aloud.
    const c = new SentenceChunker();
    const out = [
      ...c.push('Run this:\n```\nrm -rf node_modules. '),
      ...c.push('Then reinstall.\n``` Done. '),
    ];
    expect(out.length).toBeGreaterThan(0);
    for (const sentence of out) {
      const spoken = sanitizeForSpeech(sentence);
      expect(spoken).not.toContain('rm -rf');
    }
  });

  it('does not split after abbreviations', () => {
    const c = new SentenceChunker();
    expect(c.push('Use e.g. the tests. ')).toEqual(['Use e.g. the tests.']);
    expect(c.push('Dr. Smith called. ')).toEqual(['Dr. Smith called.']);
  });

  it('does not split after an ordered-list marker', () => {
    const c = new SentenceChunker();
    expect(c.push('1. Install deps\n2. Run the build. ')).toEqual([
      '1. Install deps\n2. Run the build.',
    ]);
  });
});
