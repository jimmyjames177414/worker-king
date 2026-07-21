/**
 * Inline SVG icons for the chat shell, lifted from the design mock.
 *
 * These are compile-time constants — they are the *only* strings in this
 * renderer allowed near `innerHTML` besides `renderMarkdown()` output. Nothing
 * daemon-derived is ever concatenated into them.
 */

const S = 'fill="none" stroke="currentColor" stroke-width="1.5"';

export const icons = {
  chat: `<svg width="17" height="17" viewBox="0 0 17 17" ${S} stroke-linejoin="round"><path d="M2.5 4.2a1.5 1.5 0 0 1 1.5-1.5h9a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3.2 2.4v-2.4H4a1.5 1.5 0 0 1-1.5-1.5z"/></svg>`,
  history: `<svg width="17" height="17" viewBox="0 0 17 17" ${S}><circle cx="8.5" cy="8.5" r="5.8"/><path d="M8.5 5.2v3.5l2.3 1.4" stroke-linecap="round"/></svg>`,
  watches: `<svg width="17" height="17" viewBox="0 0 17 17" ${S} stroke-linecap="round"><circle cx="8.5" cy="9.3" r="4.6"/><path d="M3.2 4.3 5 2.6M13.8 4.3 12 2.6M8.5 6.8v2.5l1.7 1"/></svg>`,
  tasks: `<svg width="17" height="17" viewBox="0 0 17 17" ${S} stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3" width="10" height="11.5" rx="1.6"/><path d="M6.2 3V2h4.6v1M5.8 7.4l1.3 1.3 2.4-2.6M5.8 11.2h4"/></svg>`,
  activity: `<svg width="17" height="17" viewBox="0 0 17 17" ${S} stroke-linecap="round" stroke-linejoin="round"><polyline points="2,9 5,9 6.8,4 10.2,13 12,9 15,9"/></svg>`,
  settings: `<svg width="17" height="17" viewBox="0 0 17 17" ${S} stroke-linecap="round"><path d="M2.5 5.5h7M14.5 5.5h-2M2.5 11.5h2M14.5 11.5h-7"/><circle cx="11" cy="5.5" r="1.9"/><circle cx="6" cy="11.5" r="1.9"/></svg>`,
  send: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7h9M7 3l4 4-4 4"/></svg>`,
  check: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.2 5.5 10l6-6.5"/></svg>`,
  cross: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>`,
  dash: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 7h7"/></svg>`,
  search: `<svg width="15" height="15" viewBox="0 0 15 15" ${S}><circle cx="6.5" cy="6.5" r="4.5"/><path d="M10 10l3 3" stroke-linecap="round"/></svg>`,
  chevron: `<svg width="13" height="13" viewBox="0 0 13 13" ${S} stroke-linecap="round"><path d="M3 4.2 6.5 8 10 4.2"/></svg>`,
  min: `<svg width="11" height="11" viewBox="0 0 11 11"><line x1="1" y1="6" x2="10" y2="6" stroke="currentColor" stroke-width="1.2"/></svg>`,
  max: `<svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`,
  restore: `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="1" y="3" width="6" height="6" rx="1.2"/><path d="M3 3V1.6A.6.6 0 0 1 3.6 1H8.4a.6.6 0 0 1 .6.6v4.8a.6.6 0 0 1-.6.6H7"/></svg>`,
  close: `<svg width="11" height="11" viewBox="0 0 11 11"><path d="M1 1L10 10M10 1L1 10" stroke="currentColor" stroke-width="1.2"/></svg>`,
} as const;

export type IconName = keyof typeof icons;

/** A span wrapping one icon. `className` is ours; the markup is a constant. */
export function iconEl(name: IconName, className = 'icon'): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.innerHTML = icons[name];
  return el;
}

/** Swap the icon inside an element built by `iconEl`. */
export function setIcon(el: HTMLElement, name: IconName): void {
  el.innerHTML = icons[name];
}
