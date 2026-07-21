import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  GptRealtimeProvider,
  extractTranscript,
  computePcm16Rms,
  type RealtimeSessionLike,
  type RealtimeTransportLike,
  type SessionFactoryConfig,
} from './GptRealtimeProvider.js';
import type { VoiceStartOptions, VoiceProviderState } from './VoiceProvider.js';

/** A fake transport that records OOB requests and lets tests emit events. */
class FakeTransport implements RealtimeTransportLike {
  requests: Array<Record<string, unknown> | undefined> = [];
  configs: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();

  on(event: string, handler: (...a: unknown[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(handler);
    this.listeners.set(event, arr);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const h of this.listeners.get(event) ?? []) h(...args);
  }
  requestResponse(payload?: Record<string, unknown>): void {
    this.requests.push(payload);
  }
  updateSessionConfig(cfg: Record<string, unknown>): void {
    this.configs.push(cfg);
  }
}

/** A fake RealtimeSession that records calls and lets tests emit events. */
class FakeSession implements RealtimeSessionLike {
  connected = false;
  muted = false;
  interruptCount = 0;
  closed = false;
  sent: string[] = [];
  connectOpts?: { apiKey: string | (() => Promise<string>); model?: string };
  transport?: FakeTransport;
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();

  constructor(withTransport = false) {
    if (withTransport) this.transport = new FakeTransport();
  }

  async connect(opts: { apiKey: string | (() => Promise<string>); model?: string }): Promise<void> {
    this.connected = true;
    this.connectOpts = opts;
  }
  sendMessage(m: string): void {
    this.sent.push(m);
  }
  interrupt(): void {
    this.interruptCount++;
  }
  mute(m: boolean): void {
    this.muted = m;
  }
  close(): void {
    this.closed = true;
  }
  on(event: string, handler: (...a: unknown[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(handler);
    this.listeners.set(event, arr);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const h of this.listeners.get(event) ?? []) h(...args);
  }
}

function makeDelegate() {
  const states: VoiceProviderState[] = [];
  const userTranscripts: Array<{ text: string; final: boolean }> = [];
  const assistantTranscripts: Array<{ text: string; final: boolean }> = [];
  const levels: number[] = [];
  const errors: Array<{ err: Error; fatal?: boolean }> = [];
  const opts: VoiceStartOptions = {
    systemPrompt: 'You are WorkerKing.',
    tools: [{ name: 'delegate_to_worker', description: 'do work', parameters: {} }],
    delegate: {
      onToolCall: vi.fn(async () => ({ ok: true })),
      onUserTranscript: (text, final) => userTranscripts.push({ text, final }),
      onAssistantTranscript: (text, final) => assistantTranscripts.push({ text, final }),
      onStateChange: (s) => states.push(s),
      onAudioLevel: (l) => levels.push(l),
      onError: (err, info) => errors.push({ err, fatal: info?.fatal }),
    },
  };
  return { opts, states, userTranscripts, assistantTranscripts, levels, errors };
}

function build(o?: {
  withTransport?: boolean;
  sessionMaxAgeMs?: number;
  retryDelayMs?: number;
  /** 1-based createSession call number that should throw (recovery-failure tests). */
  failCreate?: number;
}) {
  const sessions: FakeSession[] = [];
  const cfgs: SessionFactoryConfig[] = [];
  const provider = new GptRealtimeProvider({
    model: 'gpt-realtime-mini',
    mintKey: async () => 'ek_test',
    sessionMaxAgeMs: o?.sessionMaxAgeMs ?? 0,
    retryDelayMs: o?.retryDelayMs ?? 1,
    createSession: (cfg) => {
      if (o?.failCreate === cfgs.length + 1) throw new Error('mint refused');
      cfgs.push(cfg);
      const s = new FakeSession(o?.withTransport ?? false);
      sessions.push(s);
      return s;
    },
  });
  return {
    provider,
    sessions,
    cfgs,
    last: () => sessions[sessions.length - 1],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('updateInstructions', () => {
  it('hot-patches a live session via transport.updateSessionConfig', async () => {
    const h = build({ withTransport: true });
    const { opts } = makeDelegate();
    await h.provider.start(opts);

    h.provider.updateInstructions('FRESH PROMPT');

    expect(h.last().transport!.configs).toEqual([{ instructions: 'FRESH PROMPT' }]);
  });

  it('reseeds a recycled session from the updated prompt (no live transport patch lost)', async () => {
    const h = build({ withTransport: true });
    const { opts } = makeDelegate();
    await h.provider.start(opts);
    h.provider.updateInstructions('FRESH PROMPT');

    await h.provider.recycleSession();

    // The recycled session's instructions start from the updated base.
    expect(h.cfgs.at(-1)!.systemPrompt).toContain('FRESH PROMPT');
  });

  it('is a no-op on the wire when no session is live', () => {
    const h = build({ withTransport: true });
    // Never started → no session/transport; must not throw.
    expect(() => h.provider.updateInstructions('X')).not.toThrow();
    expect(h.sessions).toHaveLength(0);
  });
});

describe('extractTranscript', () => {
  it('reads assistant transcript from content blocks', () => {
    expect(
      extractTranscript({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_audio', transcript: 'hello there' }],
      }),
    ).toEqual({ role: 'assistant', text: 'hello there', itemId: undefined });
  });
  it('reads user text and the item id', () => {
    expect(
      extractTranscript({
        type: 'message',
        role: 'user',
        itemId: 'item_1',
        content: [{ type: 'input_text', text: 'hi' }],
      }),
    ).toEqual({ role: 'user', text: 'hi', itemId: 'item_1' });
  });
  it('ignores non-message items', () => {
    expect(extractTranscript({ type: 'function_call' })).toBeUndefined();
    expect(extractTranscript(null)).toBeUndefined();
  });
});

describe('computePcm16Rms', () => {
  it('is 0 for silence and empty buffers', () => {
    expect(computePcm16Rms(new ArrayBuffer(0))).toBe(0);
    expect(computePcm16Rms(new Int16Array([0, 0, 0, 0]).buffer)).toBe(0);
  });
  it('tolerates an odd-length buffer without throwing', () => {
    // 3 bytes: not a whole number of Int16 samples.
    const odd = new Uint8Array([0x00, 0x40, 0x11]).buffer;
    expect(() => computePcm16Rms(odd)).not.toThrow();
    expect(computePcm16Rms(odd)).toBeGreaterThanOrEqual(0);
  });

  it('rises with amplitude and clamps to 1', () => {
    const quiet = computePcm16Rms(new Int16Array([1000, -1000, 1000, -1000]).buffer);
    const loud = computePcm16Rms(new Int16Array([20000, -20000, 20000, -20000]).buffer);
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet);
    const max = computePcm16Rms(new Int16Array([32767, -32768, 32767, -32768]).buffer);
    expect(max).toBe(1);
  });
});

describe('GptRealtimeProvider', () => {
  it('connects with a lazy ephemeral key and goes to listening', async () => {
    const { provider, last } = build();
    const { opts, states } = makeDelegate();
    await provider.start(opts);

    expect(last().connected).toBe(true);
    expect(typeof last().connectOpts?.apiKey).toBe('function');
    expect(await (last().connectOpts!.apiKey as () => Promise<string>)()).toBe('ek_test');
    expect(states).toContain('listening');
  });

  it('passes system prompt + tools to the session factory', async () => {
    const { provider, cfgs } = build();
    const { opts } = makeDelegate();
    await provider.start(opts);
    expect(cfgs[0]?.systemPrompt).toBe('You are WorkerKing.');
    expect(cfgs[0]?.tools.map((t) => t.name)).toEqual(['delegate_to_worker']);
  });

  it('routes tool calls through the delegate', async () => {
    const { provider, cfgs } = build();
    const { opts } = makeDelegate();
    await provider.start(opts);
    const result = await cfgs[0]!.onToolCall('delegate_to_worker', { task: 'x' });
    expect(result).toEqual({ ok: true });
    expect(opts.delegate.onToolCall).toHaveBeenCalledWith('delegate_to_worker', { task: 'x' });
  });

  it('maps audio + transcript events to delegate callbacks and states', async () => {
    const { provider, last } = build();
    const { opts, states, assistantTranscripts } = makeDelegate();
    await provider.start(opts);

    last().emit('audio_start');
    last().emit('history_added', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_audio', transcript: 'on it' }],
    });
    last().emit('audio_stopped');

    expect(states).toContain('talking');
    expect(assistantTranscripts).toContainEqual({ text: 'on it', final: true });
    expect(states[states.length - 1]).toBe('listening');
  });

  it('interrupt() and mic mute drive the session', async () => {
    const { provider, last } = build();
    const { opts } = makeDelegate();
    await provider.start(opts);

    await provider.interrupt();
    expect(last().interruptCount).toBe(1);

    provider.setMicEnabled(false);
    expect(last().muted).toBe(true);
    provider.setMicEnabled(true);
    expect(last().muted).toBe(false);
  });

  it('falls back to sendMessage injection without a transport', async () => {
    const { provider, last } = build();
    const { opts } = makeDelegate();
    await provider.start(opts);
    await provider.injectAssistantContext('progress: 50%');
    expect(last().sent).toContain('progress: 50%');
  });

  it('forwards output audio chunks as normalized levels', async () => {
    const { provider, last } = build();
    const { opts, levels } = makeDelegate();
    await provider.start(opts);
    last().emit('audio', { type: 'audio', data: new Int16Array([16000, -16000, 16000]).buffer });
    expect(levels.length).toBe(1);
    expect(levels[0]).toBeGreaterThan(0);
    expect(levels[0]).toBeLessThanOrEqual(1);
  });

  describe('out-of-band injection (transport)', () => {
    it('speaks via requestResponse with conversation:none, not sendMessage', async () => {
      const { provider, last } = build({ withTransport: true });
      const { opts } = makeDelegate();
      await provider.start(opts);

      await provider.injectAssistantContext('task done: 3 files changed');

      expect(last().sent).toEqual([]);
      const req = last().transport!.requests[0];
      expect(req?.conversation).toBe('none');
      expect(String(req?.instructions)).toContain('task done: 3 files changed');
    });

    it('holds injections while a model turn is active and drains one per turn_done', async () => {
      const { provider, last } = build({ withTransport: true });
      const { opts } = makeDelegate();
      await provider.start(opts);
      const transport = last().transport!;

      transport.emit('turn_started');
      await provider.injectAssistantContext('update one');
      await provider.injectAssistantContext('update two');
      expect(transport.requests.length).toBe(0); // gated behind the live turn

      transport.emit('turn_done');
      expect(transport.requests.length).toBe(1); // one OOB in flight

      transport.emit('turn_done'); // the OOB response's own boundary
      expect(transport.requests.length).toBe(2);
      expect(String(transport.requests[1]?.instructions)).toContain('update two');
    });
  });

  describe('session recycling', () => {
    it('recycles on the max-age timer and reseeds the transcript', async () => {
      vi.useFakeTimers();
      const { provider, sessions, cfgs, last } = build({
        withTransport: true,
        sessionMaxAgeMs: 60_000,
      });
      const { opts } = makeDelegate();
      await provider.start(opts);

      last().emit('history_added', {
        type: 'message',
        role: 'user',
        itemId: 'u1',
        content: [{ type: 'input_text', text: 'remind me at noon' }],
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(sessions.length).toBe(2);
      expect(sessions[0].closed).toBe(true);
      expect(cfgs[1].systemPrompt).toContain('Conversation so far');
      expect(cfgs[1].systemPrompt).toContain('remind me at noon');
    });

    it('defers a due recycle until the turn boundary', async () => {
      vi.useFakeTimers();
      const { provider, sessions, last } = build({
        withTransport: true,
        sessionMaxAgeMs: 60_000,
      });
      const { opts } = makeDelegate();
      await provider.start(opts);
      const transport = last().transport!;

      transport.emit('turn_started');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sessions.length).toBe(1); // mid-turn: recycle held

      transport.emit('turn_done');
      expect(sessions.length).toBe(2);
    });

    it('stop() cancels the recycle timer', async () => {
      vi.useFakeTimers();
      const { provider, sessions } = build({ sessionMaxAgeMs: 60_000 });
      const { opts, states } = makeDelegate();
      await provider.start(opts);
      await provider.stop();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sessions.length).toBe(1);
      expect(states[states.length - 1]).toBe('idle');
    });

    it('manual recycleSession() swaps to a fresh session instance', async () => {
      const { provider, sessions } = build();
      const { opts } = makeDelegate();
      await provider.start(opts);
      await provider.recycleSession();
      expect(sessions.length).toBe(2);
      expect(sessions[0].closed).toBe(true);
      expect(sessions[1].connected).toBe(true);
    });
  });

  describe('auto-recovery', () => {
    it('recovers silently from a session error with one retry', async () => {
      vi.useFakeTimers();
      const { provider, sessions, cfgs, last } = build({ retryDelayMs: 50 });
      const { opts, states, errors } = makeDelegate();
      await provider.start(opts);
      last().emit('history_added', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_audio', transcript: 'sure thing' }],
      });

      sessions[0].emit('error', new Error('ICE failed'));
      expect(states).toContain('thinking'); // recovering, not dead

      await vi.advanceTimersByTimeAsync(50);
      expect(sessions.length).toBe(2);
      expect(sessions[0].closed).toBe(true);
      expect(errors).toEqual([]); // success is silent
      expect(states[states.length - 1]).toBe('listening');
      expect(cfgs[1].systemPrompt).toContain('sure thing'); // context reseeded
    });

    it('recovers from a transport disconnect', async () => {
      vi.useFakeTimers();
      const { provider, sessions, last } = build({ withTransport: true, retryDelayMs: 50 });
      const { opts, errors } = makeDelegate();
      await provider.start(opts);

      last().transport!.emit('connection_change', 'disconnected');
      await vi.advanceTimersByTimeAsync(50);
      expect(sessions.length).toBe(2);
      expect(errors).toEqual([]);
    });

    it('surfaces a fatal error when the retry also fails', async () => {
      vi.useFakeTimers();
      const { provider, sessions } = build({ retryDelayMs: 50, failCreate: 2 });
      const { opts, states, errors } = makeDelegate();
      await provider.start(opts);

      sessions[0].emit('error', new Error('ICE failed'));
      await vi.advanceTimersByTimeAsync(50);

      expect(errors.length).toBe(1);
      expect(errors[0].fatal).toBe(true);
      expect(states[states.length - 1]).toBe('error');
    });

    it('stop() during the backoff aborts the recovery', async () => {
      vi.useFakeTimers();
      const { provider, sessions } = build({ retryDelayMs: 50 });
      const { opts, errors } = makeDelegate();
      await provider.start(opts);

      sessions[0].emit('error', new Error('ICE failed'));
      await provider.stop();
      await vi.advanceTimersByTimeAsync(200);

      expect(sessions.length).toBe(1); // no ghost session after stop
      expect(errors).toEqual([]);
    });
  });

  describe('partial transcripts', () => {
    it('streams assistant partials from audio_transcript_delta', async () => {
      const { provider, last } = build({ withTransport: true });
      const { opts, assistantTranscripts } = makeDelegate();
      await provider.start(opts);
      const transport = last().transport!;

      transport.emit('audio_transcript_delta', { itemId: 'a1', delta: 'Sure, ' });
      transport.emit('audio_transcript_delta', { itemId: 'a1', delta: 'on it.' });
      last().emit('history_added', {
        type: 'message',
        role: 'assistant',
        itemId: 'a1',
        content: [{ type: 'output_audio', transcript: 'Sure, on it.' }],
      });

      expect(assistantTranscripts).toEqual([
        { text: 'Sure, ', final: false },
        { text: 'Sure, on it.', final: false },
        { text: 'Sure, on it.', final: true },
      ]);
    });

    it('streams user partials and dedupes the history final', async () => {
      const { provider, last } = build({ withTransport: true });
      const { opts, userTranscripts } = makeDelegate();
      await provider.start(opts);

      last().emit('transport_event', {
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'u1',
        delta: 'open the ',
      });
      last().emit('transport_event', {
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'u1',
        delta: 'settings',
      });
      last().emit('transport_event', {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'u1',
        transcript: 'open the settings',
      });
      // The same item arriving via history must not double-emit the final.
      last().emit('history_added', {
        type: 'message',
        role: 'user',
        itemId: 'u1',
        content: [{ type: 'input_audio', transcript: 'open the settings' }],
      });

      expect(userTranscripts).toEqual([
        { text: 'open the ', final: false },
        { text: 'open the settings', final: false },
        { text: 'open the settings', final: true },
      ]);
    });
  });
});
