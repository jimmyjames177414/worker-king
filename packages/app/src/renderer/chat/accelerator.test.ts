import { describe, it, expect } from 'vitest';
import { formatAccelerator, type KeyEventLike } from './accelerator.js';

function ev(partial: Partial<KeyEventLike>): KeyEventLike {
  return { key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...partial };
}

describe('formatAccelerator', () => {
  it('combines modifiers in a stable order', () => {
    expect(
      formatAccelerator(ev({ key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true })),
    ).toBe('Control+Shift+A');
    expect(
      formatAccelerator(ev({ key: ' ', code: 'Space', ctrlKey: true, altKey: true })),
    ).toBe('Control+Alt+Space');
  });

  it('maps Meta to Super and letters/digits layout-robustly', () => {
    expect(formatAccelerator(ev({ key: 'e', code: 'KeyE', metaKey: true }))).toBe('Super+E');
    expect(formatAccelerator(ev({ key: '!', code: 'Digit1', shiftKey: true }))).toBe('Shift+1');
  });

  it('handles named and function keys', () => {
    expect(formatAccelerator(ev({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true }))).toBe('Control+Up');
    expect(formatAccelerator(ev({ key: 'F5', code: 'F5' }))).toBe('F5');
    expect(formatAccelerator(ev({ key: 'Escape', code: 'Escape' }))).toBe('Escape');
  });

  it('returns null while only modifiers are held', () => {
    expect(formatAccelerator(ev({ key: 'Control', ctrlKey: true }))).toBeNull();
    expect(formatAccelerator(ev({ key: 'Shift', shiftKey: true }))).toBeNull();
  });
});
