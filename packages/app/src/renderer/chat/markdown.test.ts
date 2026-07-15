import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown.js';

describe('renderMarkdown', () => {
  it('escapes HTML so assistant output cannot inject markup', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders bold and italic', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
    expect(renderMarkdown('a *italic* b')).toContain('<em>italic</em>');
    expect(renderMarkdown('a _under_ b')).toContain('<em>under</em>');
  });

  it('renders inline code without transforming its contents', () => {
    const html = renderMarkdown('use `a**b` here');
    expect(html).toContain('<code>a**b</code>');
    expect(html).not.toContain('<strong>');
  });

  it('renders fenced code blocks and escapes their contents', () => {
    const html = renderMarkdown('```ts\nconst x = 1 < 2;\n```');
    expect(html).toContain('<pre class="code"><code>');
    expect(html).toContain('const x = 1 &lt; 2;');
  });

  it('does not apply markdown inside code fences', () => {
    const html = renderMarkdown('```\n**not bold**\n```');
    expect(html).toContain('**not bold**');
    expect(html).not.toContain('<strong>');
  });

  it('renders unordered and ordered lists', () => {
    const ul = renderMarkdown('- one\n- two');
    expect(ul).toContain('<ul><li>one</li><li>two</li></ul>');
    const ol = renderMarkdown('1. first\n2. second');
    expect(ol).toContain('<ol><li>first</li><li>second</li></ol>');
  });

  it('renders only http(s) links', () => {
    const ok = renderMarkdown('[site](https://example.com)');
    expect(ok).toContain('<a href="https://example.com"');
    expect(ok).toContain('rel="noreferrer noopener"');
    // javascript: URLs are not matched, so no anchor is produced.
    const bad = renderMarkdown('[x](javascript:alert(1))');
    expect(bad).not.toContain('<a ');
  });

  it('wraps plain paragraphs and preserves line breaks', () => {
    const html = renderMarkdown('line one\nline two\n\nsecond para');
    expect(html).toContain('<p>line one<br>line two</p>');
    expect(html).toContain('<p>second para</p>');
  });

  it('handles mixed prose, list, and code together', () => {
    const html = renderMarkdown('Here:\n\n- do `x`\n\n```\ncode\n```');
    expect(html).toContain('<p>Here:</p>');
    expect(html).toContain('<li>do <code>x</code></li>');
    expect(html).toContain('<pre class="code"><code>code</code></pre>');
  });
});
