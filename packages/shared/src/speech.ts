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
export class SentenceChunker {
  private buf = '';

  /** Add a delta; return any newly-completed sentences (in order). */
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    // A sentence = up to a terminal .!? (plus any closing quote/bracket),
    // followed by whitespace or a newline.
    const re = /^([\s\S]*?[.!?]+["'”’)\]]?)(\s+)/;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf))) {
      const sentence = m[1].trim();
      if (sentence) out.push(sentence);
      this.buf = this.buf.slice(m[0].length);
    }
    return out;
  }

  /** Return (and clear) any buffered text that never hit a sentence boundary. */
  flush(): string[] {
    const rest = this.buf.trim();
    this.buf = '';
    return rest ? [rest] : [];
  }
}
