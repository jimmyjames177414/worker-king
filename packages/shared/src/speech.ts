/**
 * sanitizeForSpeech — flatten model/markdown text into something a TTS engine
 * should actually say (N4).
 *
 * The brain returns markdown: fenced code, `inline code`, **bold**, headings,
 * bullet lists, links, and sometimes `<think>…</think>` reasoning. Fed to a TTS
 * engine verbatim, those become spoken backticks, asterisks, and long nonsensical
 * reasoning audio (the cicero "<think> leaked into TTS" lesson). This is the one
 * seam every spoken string should pass through.
 *
 * Pure and dependency-free so it runs in the daemon, main, or renderer and is
 * unit-testable.
 */
export function sanitizeForSpeech(input: string): string {
  let t = input;

  // Reasoning blocks — drop entirely.
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, ' ');

  // Fenced code blocks → a short spoken placeholder (don't read code aloud).
  t = t.replace(/```[\s\S]*?```/g, ' (code block) ');

  // Images ![alt](url) → alt; links [text](url) → text.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Inline code → its contents (backticks removed).
  t = t.replace(/`([^`]+)`/g, '$1');

  // Line-leading markdown: headings, blockquotes, list bullets, ordered markers.
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/^\s*\d+\.\s+/gm, '');

  // Emphasis wrappers **b** __b__ *i* _i_ ~~s~~ → inner text.
  t = t.replace(/(\*\*|__|~~)(.+?)\1/g, '$2');
  t = t.replace(/(^|[^\w*])[*_]([^*_]+)[*_]/g, '$1$2');

  // Any stray markdown punctuation left behind.
  t = t.replace(/[`*_~]/g, '');

  // Collapse whitespace introduced by the removals.
  t = t
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

  return t;
}

/**
 * Incrementally splits a token stream into complete sentences so the voice path
 * can start speaking the first sentence while the brain is still generating (N3)
 * — turning turn latency from sum(stages) toward max(stages). Feed deltas via
 * `push()`; call `flush()` at the end for the trailing remainder.
 */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'dr', 'mr', 'mrs', 'ms', 'vs']);
const TERMINALS = '.!?';
const CLOSERS = '"\'”’)]';

export class SentenceChunker {
  private buf = '';

  /** Add a delta; return any newly-completed sentences (in order). */
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let start = 0; // start of the pending sentence within buf
    // Inside a ``` code fence, boundaries are held until the closing fence so
    // every emitted chunk carries *balanced* fences — sanitizeForSpeech needs the
    // pair to replace the block with "(code block)" instead of reading code aloud.
    let inFence = false;
    let i = 0;
    while (i < this.buf.length) {
      if (this.buf.startsWith('```', i)) {
        inFence = !inFence;
        i += 3;
        continue;
      }
      if (inFence || !TERMINALS.includes(this.buf[i])) {
        i++;
        continue;
      }
      // A sentence = up to a run of terminal .!? (plus any closing
      // quote/bracket), followed by whitespace or a newline.
      let end = i;
      while (end < this.buf.length && TERMINALS.includes(this.buf[end])) end++;
      const singleDot = end === i + 1 && this.buf[i] === '.';
      if (end < this.buf.length && CLOSERS.includes(this.buf[end])) end++;
      if (
        end >= this.buf.length || // terminal at the stream edge — hold for more input
        !/\s/.test(this.buf[end]) ||
        (singleDot && this.isNonBoundaryPeriod(start, i))
      ) {
        i = end;
        continue;
      }
      const sentence = this.buf.slice(start, end).trim();
      if (sentence) out.push(sentence);
      while (end < this.buf.length && /\s/.test(this.buf[end])) end++;
      start = end;
      i = end;
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** True when the period at `dot` ends an abbreviation or an ordered-list marker. */
  private isNonBoundaryPeriod(start: number, dot: number): boolean {
    const before = this.buf.slice(start, dot);
    // "e.g." / "Dr." — the word (possibly dotted) right before this period.
    const word = /(?:^|[^A-Za-z0-9])([A-Za-z]+(?:\.[A-Za-z]+)*)$/.exec(before)?.[1];
    if (word && ABBREVIATIONS.has(word.toLowerCase())) return true;
    // Line-leading ordered-list marker: "1. Install deps".
    return /(?:^|\n)[ \t]*\d+$/.test(before);
  }

  /** Return (and clear) any buffered text that never hit a sentence boundary. */
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }
}
