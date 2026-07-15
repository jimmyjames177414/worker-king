/**
 * A tiny, dependency-free Markdown -> HTML renderer for assistant chat bubbles.
 *
 * Deliberately minimal (fenced/inline code, bold, italic, links, lists,
 * paragraphs) - enough to make code blocks and lists readable without pulling a
 * heavy dep into the renderer. Security: all source text is HTML-escaped before
 * any markup is introduced, and links are restricted to http(s), so assistant
 * output can never inject active markup. The output is safe to assign to
 * innerHTML.
 *
 * Extracted code/inline spans are parked behind sentinel-delimited placeholders
 * using a Unicode Private-Use character that never occurs in real text and
 * survives HTML-escaping untouched, so later transforms can't corrupt them.
 */

/** Private-use sentinel; never appears in normal assistant output. */
const S = String.fromCharCode(0xf8ff);
const codePlaceholder = (i: number): string => `${S}C${i}${S}`;
const inlinePlaceholder = (i: number): string => `${S}I${i}${S}`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMarkdown(src: string): string {
  const blocks: string[] = [];
  // 1. Pull fenced code blocks out first so their contents are never transformed.
  let text = src.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    const i = blocks.length;
    blocks.push(`<pre class="code"><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return codePlaceholder(i);
  });

  // 2. Escape everything else exactly once.
  text = escapeHtml(text);

  // 3. Inline code - protect from the inline transforms below.
  const inline: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    const i = inline.length;
    inline.push(`<code>${code}</code>`);
    return inlinePlaceholder(i);
  });

  // 4. Links [label](http(s)://url) - the URL was escaped in step 2, so &amp; etc. are fine.
  text = text.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) =>
      `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`,
  );

  // 5. Bold then italic.
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/(^|[^\w_])_([^_\n]+)_/g, '$1<em>$2</em>');

  // 6. Block structure: group lines into lists / paragraphs / standalone code blocks.
  const html = blockify(text);

  // 7. Restore protected spans.
  return html
    .replace(new RegExp(`${S}I(\\d+)${S}`, 'g'), (_m, i) => inline[Number(i)])
    .replace(new RegExp(`${S}C(\\d+)${S}`, 'g'), (_m, i) => blocks[Number(i)]);
}

function blockify(text: string): string {
  const codeOnlyRe = new RegExp(`^${S}C\\d+${S}$`);
  const lines = text.split('\n');
  const out: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join('<br>')}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.type}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.type}>`);
      list = null;
    }
  };

  for (const line of lines) {
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line);

    if (codeOnlyRe.test(line.trim())) {
      flushPara();
      flushList();
      out.push(line.trim());
    } else if (ul) {
      flushPara();
      if (list?.type !== 'ul') flushList();
      list = list ?? { type: 'ul', items: [] };
      list.items.push(ul[1]);
    } else if (ol) {
      flushPara();
      if (list?.type !== 'ol') flushList();
      list = list ?? { type: 'ol', items: [] };
      list.items.push(ol[1]);
    } else if (line.trim() === '') {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join('');
}
