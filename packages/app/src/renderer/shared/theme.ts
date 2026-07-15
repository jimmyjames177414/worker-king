/**
 * Theme resolution + application shared by the renderers.
 *
 * The pages style themselves with CSS system colors (Canvas/CanvasText/Field),
 * which follow the document's `color-scheme`. So applying a theme is just forcing
 * `color-scheme` (and a `data-theme` attribute for any explicit CSS hooks). A
 * 'system' preference follows prefers-color-scheme. resolveTheme is pure; applyTheme
 * takes injectable root/prefersDark for testing.
 */

export type ThemePref = 'system' | 'light' | 'dark';

export function resolveTheme(pref: ThemePref, systemPrefersDark: boolean): 'light' | 'dark' {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemPrefersDark ? 'dark' : 'light';
}

export function normalizeThemePref(value: unknown): ThemePref {
  return value === 'light' || value === 'dark' ? value : 'system';
}

interface ThemeRoot {
  style: { colorScheme: string };
  setAttribute(name: string, value: string): void;
}

export interface ApplyThemeOptions {
  root?: ThemeRoot;
  prefersDark?: boolean;
}

/** Force the resolved theme onto the document root; returns what was applied. */
export function applyTheme(pref: ThemePref, opts: ApplyThemeOptions = {}): 'light' | 'dark' {
  const prefersDark =
    opts.prefersDark ??
    (typeof window !== 'undefined' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  const resolved = resolveTheme(pref, prefersDark === true);
  const root = opts.root ?? document.documentElement;
  root.style.colorScheme = resolved;
  root.setAttribute('data-theme', resolved);
  return resolved;
}
