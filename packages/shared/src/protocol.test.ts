import { describe, it, expect } from 'vitest';
import {
  makeEnvelope,
  parseEnvelope,
  serializeEnvelope,
  ProtocolError,
  isKind,
  PROTOCOL_VERSION,
  type EnvelopeContext,
} from './protocol.js';

// Deterministic context so tests never touch Date.now/crypto.
let counter = 0;
const ctx: EnvelopeContext = {
  newId: () => `id-${++counter}`,
  now: () => 1_700_000_000_000,
};

describe('makeEnvelope + parseEnvelope round-trip', () => {
  it('round-trips a chat.user_message', () => {
    const env = makeEnvelope(ctx, 'chat.user_message', { text: 'hello' });
    expect(env.v).toBe(PROTOCOL_VERSION);
    expect(env.kind).toBe('chat.user_message');

    const wire = serializeEnvelope(env);
    const parsed = parseEnvelope(wire);

    expect(parsed).toEqual(env);
    if (isKind(parsed, 'chat.user_message')) {
      expect(parsed.payload.text).toBe('hello');
    } else {
      throw new Error('kind narrowing failed');
    }
  });

  it('round-trips a task.progress broadcast', () => {
    const env = makeEnvelope(ctx, 'task.progress', {
      taskId: 't1',
      progress: { ts: 1, phase: 'tool', text: 'running bash', spoken: false },
    });
    const parsed = parseEnvelope(serializeEnvelope(env));
    expect(parsed.payload).toEqual(env.payload);
  });

  it('carries replyTo on responses', () => {
    const req = makeEnvelope(ctx, 'voice.tool_call', { name: 'x', args: {} });
    const res = makeEnvelope(
      ctx,
      'voice.tool_result',
      { result: { ok: true }, isError: false },
      { replyTo: req.id },
    );
    expect(res.replyTo).toBe(req.id);
    const parsed = parseEnvelope(serializeEnvelope(res));
    expect(parsed.replyTo).toBe(req.id);
  });

  it('applies zod defaults inside payloads', () => {
    // isError defaults to false; speakNow defaults to false.
    const env = makeEnvelope(ctx, 'voice.inject', { text: 'progress' });
    if (isKind(env, 'voice.inject')) {
      expect(env.payload.speakNow).toBe(false);
    }
  });

  it('round-trips a screen.capture_request with defaults', () => {
    const env = makeEnvelope(ctx, 'screen.capture_request', {});
    if (isKind(env, 'screen.capture_request')) {
      expect(env.payload.target).toBe('window');
      expect(env.payload.includeImage).toBe(true);
    }
    const parsed = parseEnvelope(serializeEnvelope(env));
    expect(parsed.payload).toEqual(env.payload);
  });

  it('round-trips a screen.capture_result', () => {
    const env = makeEnvelope(ctx, 'screen.capture_result', {
      ok: true,
      activeWindowTitle: 'notes.txt — Notepad',
      imageDataUrl: 'data:image/png;base64,AAAA',
    });
    const parsed = parseEnvelope(serializeEnvelope(env));
    expect(parsed.payload).toEqual(env.payload);
  });

  it('round-trips a proactive.notify with defaults', () => {
    const env = makeEnvelope(ctx, 'proactive.notify', { text: 'Standup in 5 minutes' });
    if (isKind(env, 'proactive.notify')) {
      expect(env.payload.level).toBe('info');
      expect(env.payload.speak).toBe(true);
    }
    expect(parseEnvelope(serializeEnvelope(env)).payload).toEqual(env.payload);
  });

  it('validates voice.audio_level bounds', () => {
    const env = makeEnvelope(ctx, 'voice.audio_level', { level: 0.5 });
    expect(parseEnvelope(serializeEnvelope(env)).payload).toEqual({ level: 0.5 });
    const bad = { v: 1, id: 'x', kind: 'voice.audio_level', ts: 0, payload: { level: 5 } };
    expect(() => parseEnvelope(bad)).toThrowError(ProtocolError);
  });
});

describe('parseEnvelope validation', () => {
  it('rejects non-JSON strings', () => {
    expect(() => parseEnvelope('{not json')).toThrowError(ProtocolError);
    try {
      parseEnvelope('{not json');
    } catch (e) {
      expect((e as ProtocolError).code).toBe('bad_json');
    }
  });

  it('rejects a wrong protocol version', () => {
    const bad = { v: 999, id: 'x', kind: 'ping', ts: 0, payload: {} };
    try {
      parseEnvelope(bad);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolError);
      expect((e as ProtocolError).code).toBe('bad_envelope');
    }
  });

  it('rejects an unknown kind', () => {
    const bad = { v: 1, id: 'x', kind: 'not.a.kind', ts: 0, payload: {} };
    expect(() => parseEnvelope(bad)).toThrowError(ProtocolError);
  });

  it('rejects a payload that violates its kind schema', () => {
    // chat.user_message requires `text: string`.
    const bad = { v: 1, id: 'x', kind: 'chat.user_message', ts: 0, payload: { text: 42 } };
    try {
      parseEnvelope(bad);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolError);
      expect((e as ProtocolError).code).toBe('bad_payload');
    }
  });

  it('rejects a hello without a token', () => {
    const bad = { v: 1, id: 'x', kind: 'hello', ts: 0, payload: { role: 'chat' } };
    expect(() => parseEnvelope(bad)).toThrowError(ProtocolError);
  });
});
