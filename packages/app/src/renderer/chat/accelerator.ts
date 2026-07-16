/**
 * Translate a keyboard event into an Electron accelerator string
 * (e.g. "Control+Shift+Space"), for the click-to-record hotkey fields in
 * settings. Returns null while only modifiers are held (so the caller keeps
 * listening until a real key lands), for chords without any modifier, and for
 * keys that can't form a valid Electron accelerator. Pure and layout-robust
 * (uses `code` for letters/digits), so it's unit-tested without a DOM.
 */

export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS']);

const NAMED: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Escape',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

function normalizeKey(e: KeyEventLike): string | null {
  if (e.code === 'Space' || e.key === ' ') return 'Space';
  if (e.code.startsWith('Key')) return e.code.slice(3); // KeyA -> A
  if (e.code.startsWith('Digit')) return e.code.slice(5); // Digit1 -> 1
  if (/^F\d{1,2}$/.test(e.key)) return e.key; // F1..F24
  if (NAMED[e.key]) return NAMED[e.key];
  // Bare single characters: only ASCII letters/digits. Anything else ('+',
  // dead keys, non-ASCII like 'Ù') would produce an accelerator that
  // globalShortcut.register throws on.
  if (/^[a-zA-Z0-9]$/.test(e.key)) return e.key.toUpperCase();
  return null;
}

export function formatAccelerator(e: KeyEventLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const key = normalizeKey(e);
  if (!key) return null;

  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  // A global chord needs at least one modifier — a bare key would be swallowed
  // system-wide (and a bare 'A' hotkey would eat every keystroke of it).
  if (parts.length === 0) return null;
  parts.push(key);
  return parts.join('+');
}
