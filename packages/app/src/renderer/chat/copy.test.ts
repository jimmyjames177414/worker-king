import { describe, it, expect } from 'vitest';
import { copyToClipboard } from './copy.js';

describe('copyToClipboard', () => {
  it('writes text and reports success', async () => {
    const written: string[] = [];
    const ok = await copyToClipboard('hello', { writeText: async (t) => void written.push(t) });
    expect(ok).toBe(true);
    expect(written).toEqual(['hello']);
  });

  it('returns false when the clipboard is unavailable', async () => {
    expect(await copyToClipboard('x', undefined)).toBe(false);
  });

  it('swallows write failures and returns false', async () => {
    const ok = await copyToClipboard('x', {
      writeText: async () => {
        throw new Error('denied');
      },
    });
    expect(ok).toBe(false);
  });
});
