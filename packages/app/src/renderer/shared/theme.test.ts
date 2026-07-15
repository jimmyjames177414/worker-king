import { describe, it, expect } from 'vitest';
import { resolveTheme, normalizeThemePref, applyTheme } from './theme.js';

describe('resolveTheme', () => {
  it('honors explicit light/dark', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('follows the system preference for "system"', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('normalizeThemePref', () => {
  it('defaults unknown values to system', () => {
    expect(normalizeThemePref('dark')).toBe('dark');
    expect(normalizeThemePref('light')).toBe('light');
    expect(normalizeThemePref('nonsense')).toBe('system');
    expect(normalizeThemePref(undefined)).toBe('system');
  });
});

describe('applyTheme', () => {
  it('writes color-scheme and data-theme onto the root', () => {
    const attrs: Record<string, string> = {};
    const root = {
      style: { colorScheme: '' },
      setAttribute: (n: string, v: string) => void (attrs[n] = v),
    };
    const applied = applyTheme('system', { root, prefersDark: true });
    expect(applied).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    expect(attrs['data-theme']).toBe('dark');
  });
});
