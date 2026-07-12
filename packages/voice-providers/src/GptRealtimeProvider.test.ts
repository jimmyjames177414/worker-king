import { describe, it, expect, vi } from 'vitest';
import {
  GptRealtimeProvider,
  extractTranscript,
  type RealtimeSessionLike,
  type SessionFactoryConfig,
} from './GptRealtimeProvider.js';
import type { VoiceStartOptions, VoiceProviderState } from './VoiceProvider.js';

/** A fake RealtimeSession that records calls and lets tests emit events. */
class FakeSession implements RealtimeSessionLike {
  connected = false;
  muted = false;
  interruptCount = 0;
  closed = false;
  sent: string[] = [];
  connectOpts?: { apiKey: string | (() => Promise<string>); model?: string };
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();

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
  const userTranscripts: string[] = [];
  const assistantTranscripts: string[] = [];
  const errors: Error[] = [];
  const opts: VoiceStartOptions = {
    systemPrompt: 'You are WorkerKing.',
    tools: [{ name: 'delegate_to_worker', description: 'do work', parameters: {} }],
    delegate: {
      onToolCall: vi.fn(async () => ({ ok: true })),
      onUserTranscript: (t) => userTranscripts.push(t),
      onAssistantTranscript: (t) => assistantTranscripts.push(t),
      onStateChange: (s) => states.push(s),
      onError: (e) => errors.push(e),
    },
  };
  return { opts, states, userTranscripts, assistantTranscripts, errors };
}

describe('extractTranscript', () => {
  it('reads assistant transcript from content blocks', () => {
    expect(
      extractTranscript({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_audio', transcript: 'hello there' }],
      }),
    ).toEqual({ role: 'assistant', text: 'hello there' });
  });
  it('reads user text', () => {
    expect(
      extractTranscript({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }),
    ).toEqual({ role: 'user', text: 'hi' });
  });
  it('ignores non-message items', () => {
    expect(extractTranscript({ type: 'function_call' })).toBeUndefined();
    expect(extractTranscript(null)).toBeUndefined();
  });
});

describe('GptRealtimeProvider', () => {
  function build() {
    const fake = new FakeSession();
    let factoryCfg: SessionFactoryConfig | undefined;
    const provider = new GptRealtimeProvider({
      model: 'gpt-realtime-mini',
      mintKey: async () => 'ek_test',
      createSession: (cfg) => {
        factoryCfg = cfg;
        return fake;
      },
    });
    return { provider, fake, getCfg: () => factoryCfg };
  }

  it('connects with a lazy ephemeral key and goes to listening', async () => {
    const { provider, fake } = build();
    const { opts, states } = makeDelegate();
    await provider.start(opts);

    expect(fake.connected).toBe(true);
    expect(typeof fake.connectOpts?.apiKey).toBe('function');
    expect(await (fake.connectOpts!.apiKey as () => Promise<string>)()).toBe('ek_test');
    expect(states).toContain('listening');
  });

  it('passes system prompt + tools to the session factory', async () => {
    const { provider, getCfg } = build();
    const { opts } = makeDelegate();
    await provider.start(opts);
    expect(getCfg()?.systemPrompt).toBe('You are WorkerKing.');
    expect(getCfg()?.tools.map((t) => t.name)).toEqual(['delegate_to_worker']);
  });

  it('routes tool calls through the delegate', async () => {
    const { provider, getCfg } = build();
    const { opts } = makeDelegate();
    await provider.start(opts);
    const result = await getCfg()!.onToolCall('delegate_to_worker', { task: 'x' });
    expect(result).toEqual({ ok: true });
    expect(opts.delegate.onToolCall).toHaveBeenCalledWith('delegate_to_worker', { task: 'x' });
  });

  it('maps audio + transcript events to delegate callbacks and states', async () => {
    const { provider, fake } = build();
    const { opts, states, assistantTranscripts } = makeDelegate();
    await provider.start(opts);

    fake.emit('audio_start');
    fake.emit('history_added', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_audio', transcript: 'on it' }],
    });
    fake.emit('audio_stopped');

    expect(states).toContain('talking');
    expect(assistantTranscripts).toContain('on it');
    expect(states[states.length - 1]).toBe('listening');
  });

  it('interrupt(), mic mute, and recycle drive the session', async () => {
    const { provider, fake } = build();
    const { opts } = makeDelegate();
    await provider.start(opts);

    await provider.interrupt();
    expect(fake.interruptCount).toBe(1);

    provider.setMicEnabled(false);
    expect(fake.muted).toBe(true);
    provider.setMicEnabled(true);
    expect(fake.muted).toBe(false);

    await provider.injectAssistantContext('progress: 50%');
    expect(fake.sent).toContain('progress: 50%');

    await provider.recycleSession();
    expect(fake.closed).toBe(true); // old session closed during recycle
  });

  it('surfaces session errors and sets error state', async () => {
    const { provider, fake } = build();
    const { opts, states, errors } = makeDelegate();
    await provider.start(opts);
    fake.emit('error', new Error('ICE failed'));
    expect(states).toContain('error');
    expect(errors[0]?.message).toBe('ICE failed');
  });
});
