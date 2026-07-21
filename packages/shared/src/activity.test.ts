import { describe, it, expect } from 'vitest';
import {
  activityLabel,
  summarizeToolInput,
  previewToolResult,
  truncateThinking,
  ACTIVITY_MAX_SUMMARY,
  ACTIVITY_MAX_PREVIEW,
  ACTIVITY_MAX_THINKING,
} from './activity.js';

describe('activityLabel', () => {
  it('keeps built-in tool names', () => {
    expect(activityLabel('Bash')).toBe('Bash');
    expect(activityLabel('Read')).toBe('Read');
  });
  it('collapses mcp names to server/tool', () => {
    expect(activityLabel('mcp__github__create_pull_request')).toBe('github/create pull request');
  });
  it('falls back to the raw name', () => {
    expect(activityLabel('Whatever')).toBe('Whatever');
  });
});

describe('summarizeToolInput', () => {
  it('pulls the salient field per tool', () => {
    expect(summarizeToolInput('Bash', { command: 'pnpm build' })).toBe('pnpm build');
    expect(summarizeToolInput('Read', { file_path: 'src/a.ts' })).toBe('src/a.ts');
    expect(summarizeToolInput('Edit', { file_path: 'src/b.ts' })).toBe('src/b.ts');
    expect(summarizeToolInput('Grep', { pattern: 'foo', path: 'src' })).toBe('foo in src');
    expect(summarizeToolInput('WebFetch', { url: 'https://x.dev' })).toBe('https://x.dev');
    expect(summarizeToolInput('WebSearch', { query: 'zod' })).toBe('zod');
    expect(summarizeToolInput('Task', { description: 'do it' })).toBe('do it');
  });
  it('JSON-dumps unknown/MCP tool inputs', () => {
    expect(summarizeToolInput('mcp__srv__thing', { a: 1 })).toBe('{"a":1}');
  });
  it('hard-caps oversized input', () => {
    const long = 'x'.repeat(500);
    const out = summarizeToolInput('Bash', { command: long });
    expect(out.length).toBeLessThanOrEqual(ACTIVITY_MAX_SUMMARY);
    expect(out.endsWith('…')).toBe(true);
  });
  it('never throws on odd input', () => {
    expect(summarizeToolInput('Read', null)).toBe('');
    expect(summarizeToolInput('Bash', undefined)).toBe('');
  });
});

describe('previewToolResult', () => {
  it('handles a plain string result', () => {
    expect(previewToolResult('hello', false)).toEqual({ ok: true, preview: 'hello' });
  });
  it('joins text blocks and marks images', () => {
    const { preview } = previewToolResult(
      [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }],
      false,
    );
    expect(preview).toBe('a [image] b');
  });
  it('reflects the error flag', () => {
    expect(previewToolResult('nope', true).ok).toBe(false);
  });
  it('truncates long previews', () => {
    const { preview } = previewToolResult('y'.repeat(500), false);
    expect(preview.length).toBeLessThanOrEqual(ACTIVITY_MAX_PREVIEW);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('truncateThinking', () => {
  it('caps to the thinking limit', () => {
    const out = truncateThinking('z'.repeat(ACTIVITY_MAX_THINKING + 100));
    expect(out.length).toBeLessThanOrEqual(ACTIVITY_MAX_THINKING);
    expect(out.endsWith('…')).toBe(true);
  });
  it('leaves short text alone', () => {
    expect(truncateThinking('  short  ')).toBe('short');
  });
});
