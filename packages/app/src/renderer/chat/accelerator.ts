/**
 * Translate a keyboard event into an Electron accelerator string
 * (e.g. "Control+Shift+Space"), for the click-to-record hotkey fields in
 * settings. Returns null while only modifiers are held, so the caller keeps
 * listening until a real key lands. Pure and layout-robust (uses `code` for
 * letters/digits), so it's unit-tested without a DOM.
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
  if (e.key.length === 1) return e.key.toUpperCase();
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
  parts.push(key);
  return parts.join('+');
}
