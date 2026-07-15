import { describe, it, expect, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  ClaudeBackend,
  ClaudeAuthError,
  ClaudeRateLimitError,
  extractTextDelta,
  extractUsage,
  type ClaudeQueryFn,
} from './ClaudeBackend.js';

/** Build a fake stream_event carrying a text delta. */
function textDelta(text: string): SDKMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    parent_tool_use_id: null,
    uuid: 'u',
    session_id: 's',
  } as unknown as SDKMessage;
}

function successResult(sessionId: string, result: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result,
    is_error: false,
    num_turns: 1,
  } as unknown as SDKMessage;
}

/** Turn an array of messages into a queryFn that yields them. */
function fakeQuery(messages: SDKMessage[], onParams?: (p: unknown) => void): ClaudeQueryFn {
  return (params) => {
    onParams?.(params);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
}

describe('extractTextDelta', () => {
  it('extracts text from a content_block_delta/text_delta', () => {
    expect(
      extractTextDelta({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }),
    ).toBe('hi');
  });
  it('ignores non-text events', () => {
    expect(extractTextDelta({ type: 'message_start' })).toBeUndefined();
    expect(extractTextDelta(null)).toBeUndefined();
    expect(
      extractTextDelta({ type: 'content_block_delta', delta: { type: 'input_json_delta' } }),
    ).toBeUndefined();
  });
});

describe('ClaudeBackend.respond', () => {
  it('streams text deltas and returns the accumulated text', async () => {
    const backend = new ClaudeBackend({
      queryFn: fakeQuery([
        textDelta('Hello'),
        textDelta(', '),
        textDelta('world'),
        successResult('sess-1', 'Hello, world'),
      ]),
    });

    const deltas: string[] = [];
    const full = await backend.respond('hi', (d) => deltas.push(d));

    expect(deltas).toEqual(['Hello', ', ', 'world']);
    expect(full).toBe('Hello, world');
  });

  it('falls back to result text when no deltas were streamed', async () => {
    const backend = new ClaudeBackend({
      queryFn: fakeQuery([successResult('s', 'terse answer')]),
    });
    const full = await backend.respond('hi', () => {});
    expect(full).toBe('terse answer');
  });

  it('captures session_id and resumes it on the next message', async () => {
    const seenParams: unknown[] = [];
    const qf = vi
      .fn<ClaudeQueryFn>()
      .mockImplementationOnce(
        fakeQuery([textDelta('one'), successResult('sess-A', 'one')], (p) => seenParams.push(p)),
      )
      .mockImplementationOnce(
        fakeQuery([textDelta('two'), successResult('sess-A', 'two')], (p) => seenParams.push(p)),
      );

    const backend = new ClaudeBackend({ queryFn: qf as ClaudeQueryFn });

    await backend.respond('first', () => {});
    expect(backend.getSessionId()).toBe('sess-A');
    await backend.respond('second', () => {});

    // First call has no resume; second resumes the captured session.
    const opts0 = (seenParams[0] as { options?: { resume?: string } }).options;
    const opts1 = (seenParams[1] as { options?: { resume?: string } }).options;
    expect(opts0?.resume).toBeUndefined();
    expect(opts1?.resume).toBe('sess-A');
  });

  it('applies the persona as a preset+append system prompt', async () => {
    let captured: { options?: { systemPrompt?: unknown } } | undefined;
    const backend = new ClaudeBackend({
      personaAppend: 'You are Jarvis.',
      queryFn: fakeQuery([successResult('s', 'ok')], (p) => {
        captured = p as typeof captured;
      }),
    });
    await backend.respond('hi', () => {});
    expect(captured?.options?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'You are Jarvis.',
    });
  });

  it('maps auth-shaped failures to ClaudeAuthError', async () => {
    const backend = new ClaudeBackend({
      queryFn: () =>
        (async function* (): AsyncGenerator<SDKMessage> {
          throw new Error('Not logged in: please run claude login');
        })(),
    });
    await expect(backend.respond('hi', () => {})).rejects.toBeInstanceOf(ClaudeAuthError);
  });

  it('throws on a non-success result subtype', async () => {
    const backend = new ClaudeBackend({
      queryFn: fakeQuery([
        { type: 'result', subtype: 'error_max_turns', session_id: 's' } as unknown as SDKMessage,
      ]),
    });
    await expect(backend.respond('hi', () => {})).rejects.toThrow(/error_max_turns/);
  });

  it('maps a 429 to ClaudeRateLimitError, parsing retry-after', async () => {
    const backend = new ClaudeBackend({
      queryFn: () =>
        (async function* (): AsyncGenerator<SDKMessage> {
          throw new Error('HTTP 429 too many requests; retry-after: 30');
        })(),
    });
    const err = await backend.respond('hi', () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(ClaudeRateLimitError);
    expect((err as ClaudeRateLimitError).retryAfterSec).toBe(30);
  });

  it('maps an error_usage_limit subtype to ClaudeRateLimitError', async () => {
    const backend = new ClaudeBackend({
      queryFn: fakeQuery([
        { type: 'result', subtype: 'error_usage_limit', session_id: 's' } as unknown as SDKMessage,
      ]),
    });
    await expect(backend.respond('hi', () => {})).rejects.toBeInstanceOf(ClaudeRateLimitError);
  });

  it('captures usage from the result message', async () => {
    const backend = new ClaudeBackend({
      queryFn: fakeQuery([
        {
          type: 'result',
          subtype: 'success',
          session_id: 's',
          result: 'ok',
          usage: { input_tokens: 12, output_tokens: 34 },
          total_cost_usd: 0.001,
        } as unknown as SDKMessage,
      ]),
    });
    await backend.respond('hi', () => {});
    expect(backend.getLastUsage()).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      totalCostUsd: 0.001,
    });
  });
});

describe('extractUsage', () => {
  it('returns undefined when no usage fields are present', () => {
    expect(extractUsage({ type: 'result' })).toBeUndefined();
    expect(extractUsage(null)).toBeUndefined();
  });
});
