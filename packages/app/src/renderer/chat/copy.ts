/**
 * Copy affordances for chat: a "copy message" button on assistant replies and a
 * copy button on each fenced code block. The clipboard write is factored out
 * (`copyToClipboard`) so it can be unit-tested with a fake; the DOM decorators
 * run in the renderer.
 */

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

/** Write text to the clipboard, returning whether it succeeded (never throws). */
export async function copyToClipboard(
  text: string,
  // `globalThis.navigator?.` (not a bare `navigator`) so this never throws in a
  // no-DOM environment — e.g. the CI test runner on Node 20, where `navigator`
  // isn't a global. There it resolves to undefined and we return false.
  clip: ClipboardLike | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  try {
    if (!clip) return false;
    await clip.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Briefly flip a button's label to a tick (or cross) to confirm the copy. */
function flash(btn: HTMLElement, ok: boolean): void {
  const original = btn.textContent;
  btn.textContent = ok ? '✓' : '✗';
  setTimeout(() => {
    btn.textContent = original;
  }, 1000);
}

function makeButton(label: string, title: string, className: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.title = title;
  btn.textContent = label;
  return btn;
}

/**
 * Add a "copy message" button plus a per-code-block copy button to a rendered
 * assistant bubble. `rawText` is the original Markdown source (so copying the
 * message yields Markdown, not the rendered HTML's text).
 */
export function decorateAssistantBubble(bubble: HTMLElement, rawText: string): void {
  const copyMsg = makeButton('⧉', 'Copy message', 'bubble__copy');
  copyMsg.addEventListener('click', async () => flash(copyMsg, await copyToClipboard(rawText)));
  const actions = document.createElement('div');
  actions.className = 'bubble__actions';
  actions.appendChild(copyMsg);
  bubble.appendChild(actions);

  bubble.querySelectorAll('pre.code').forEach((pre) => {
    const code = pre.querySelector('code')?.textContent ?? '';
    const btn = makeButton('Copy', 'Copy code', 'code__copy');
    btn.addEventListener('click', async () => flash(btn, await copyToClipboard(code)));
    (pre as HTMLElement).appendChild(btn);
  });
}
