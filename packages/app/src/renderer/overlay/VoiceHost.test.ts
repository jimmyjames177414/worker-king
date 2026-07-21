import { describe, it, expect, vi, afterEach } from 'vitest';
import { VoiceHost, type VoiceBus } from './VoiceHost.js';
import type {
  VoiceProvider,
  VoiceStartOptions,
  VoiceTurnDelegate,
} from '@workerking/voice-providers';
import type { WsEnvelope, WsMessageKind } from '@workerking/shared';

const micro = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** In-memory VoiceBus: records sends, lets tests emit inbound envelopes. */
class FakeBus implements VoiceBus {
  sent: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  private handlers = new Map<string, Set<(env: WsEnvelope) => void>>();

  on<K extends WsMessageKind>(kind: K, handler: (env: WsEnvelope<K>) => void): () => void {
    const set = this.handlers.get(kind) ?? new Set();
    set.add(handler as (env: WsEnvelope) => void);
    this.handlers.set(kind, set);
    return () => set.delete(handler as (env: WsEnvelope) => void);
  }
  send(kind: WsMessageKind, payload: unknown): void {
    this.sent.push({ kind, payload: payload as Record<string, unknown> });
  }
  async request(): Promise<WsEnvelope> {
    return { id: 'r', ts: 0, kind: 'voice.tool_result', payload: { result: {} } } as WsEnvelope;
  }
  emit(kind: string, payload: unknown): void {
    const env = { id: 'e', ts: 0, kind, payload } as unknown as WsEnvelope;
    for (const h of this.handlers.get(kind) ?? new Set()) h(env);
  }
  sentOf(kind: string): Array<Record<string, unknown>> {
    return this.sent.filter((s) => s.kind === kind).map((s) => s.payload);
  }
}

/** Fake provider: records injected speech, exposes the delegate to the test. */
class FakeProvider implements VoiceProvider {
  readonly id = 'local-cascade' as const;
  injected: string[] = [];
  instructions: string[] = [];
  stopped = false;
  delegate?: VoiceTurnDelegate;
  async start(opts: VoiceStartOptions): Promise<void> {
    this.delegate = opts.delegate;
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  async injectAssistantContext(text: string): Promise<void> {
    this.injected.push(text);
  }
  updateInstructions(systemPrompt: string): void {
    this.instructions.push(systemPrompt);
  }
  async interrupt(): Promise<void> {}
  setMicEnabled(): void {}
  async recycleSession(): Promise<void> {}
}

async function startCascadeHost() {
  const bus = new FakeBus();
  const provider = new FakeProvider();
  const host = new VoiceHost(
    bus,
    { mintRealtimeKey: async () => 'ek', onPushToTalk: () => {} },
    () => 'persona',
    async () => provider,
  );
  bus.emit('config.changed', { key: 'voiceProvider', value: 'local-cascade' });
  await host.toggle();
  return { bus, provider, host };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceHost (cascade)', () => {
  it('streams reply sentences to the provider as deltas arrive', async () => {
    const { bus, provider } = await startCascadeHost();

    provider.delegate!.onUserTranscript('what time is it', true);
    await micro();
    const msg = bus.sentOf('chat.user_message')[0];
    expect(msg?.text).toBe('what time is it');
    const messageId = msg?.messageId;

    bus.emit('chat.assistant_delta', { messageId, delta: 'It is noon. Enjoy ' });
    bus.emit('chat.assistant_delta', { messageId, delta: 'lunch.' });
    bus.emit('chat.assistant_done', { messageId, text: 'It is noon. Enjoy lunch.' });
    await micro();

    expect(provider.injected).toEqual(['It is noon.', 'Enjoy lunch.']);
  });

  it('a barge-in drops the rest of the in-flight reply', async () => {
    const { bus, provider } = await startCascadeHost();

    provider.delegate!.onUserTranscript('tell me a story', true);
    await micro();
    const messageId = bus.sentOf('chat.user_message')[0]?.messageId;

    bus.emit('chat.assistant_delta', { messageId, delta: 'Once upon a time. ' });
    provider.delegate!.onSpeechStart?.(); // user talks over the reply
    bus.emit('chat.assistant_delta', { messageId, delta: 'There was a dragon. ' });
    bus.emit('chat.assistant_done', { messageId, text: 'unused' });
    await micro();

    expect(provider.injected).toEqual(['Once upon a time.']); // nothing after the barge-in
  });

  it('updateContext hot-patches a live session and no-ops once stopped', async () => {
    const { provider, host } = await startCascadeHost();

    host.updateContext('fresh voice prompt');
    expect(provider.instructions).toEqual(['fresh voice prompt']);

    await host.stop();
    host.updateContext('after stop'); // idle → no live session to patch
    expect(provider.instructions).toEqual(['fresh voice prompt']);
  });

  it('speaks a failure notice and flags the avatar when the brain times out', async () => {
    vi.useFakeTimers();
    const { bus, provider } = await startCascadeHost();

    provider.delegate!.onUserTranscript('do the thing', true);
    await vi.advanceTimersByTimeAsync(60_000);
    await micro();

    expect(provider.injected.some((t) => t.includes("didn't go through"))).toBe(true);
    const captions = bus.sentOf('voice.transcript').map((p) => p.text);
    expect(captions.some((t) => String(t).includes("didn't go through"))).toBe(true);
    const states = bus.sentOf('voice.state').map((p) => p.state);
    expect(states).toContain('error');
  });

  it('auto-stops after 15s of genuine silence (state stays "listening")', async () => {
    vi.useFakeTimers();
    const { bus, provider } = await startCascadeHost();

    provider.delegate!.onStateChange?.('listening'); // arms the silence clock
    await vi.advanceTimersByTimeAsync(15_000);
    await micro();

    expect(provider.stopped).toBe(true);
    const captions = bus.sentOf('voice.transcript').map((p) => p.text);
    expect(captions.some((t) => String(t).includes('Going idle'))).toBe(true);
    const states = bus.sentOf('voice.state').map((p) => p.state);
    expect(states.at(-1)).toBe('idle');
  });

  it('a slow reply (state stuck on "thinking") never trips the silence timeout', async () => {
    vi.useFakeTimers();
    const { provider } = await startCascadeHost();

    provider.delegate!.onStateChange?.('listening'); // arms it
    provider.delegate!.onStateChange?.('thinking'); // ...then clears it — turn in flight
    await vi.advanceTimersByTimeAsync(60_000); // far past the 15s window
    await micro();

    // Still not stopped: "thinking" isn't silence, no matter how long it takes.
    expect(provider.stopped).toBe(false);
  });

  it('rate-limits spoken task progress to one line per gap, speaking the latest', async () => {
    vi.useFakeTimers();
    const { bus, provider } = await startCascadeHost();

    bus.emit('task.progress', { taskId: 't1', progress: { text: 'reading files' } });
    bus.emit('task.progress', { taskId: 't1', progress: { text: 'running tests' } });
    bus.emit('task.progress', { taskId: 't1', progress: { text: 'still running tests' } });
    await Promise.resolve();

    expect(provider.injected).toEqual(['reading files']); // first speaks immediately

    await vi.advanceTimersByTimeAsync(6000);
    // Gap elapsed: only the LATEST pending update is spoken, not the backlog.
    expect(provider.injected).toEqual(['reading files', 'still running tests']);
  });

  it('a final result bypasses the gate and drops any pending progress line', async () => {
    vi.useFakeTimers();
    const { bus, provider } = await startCascadeHost();

    bus.emit('task.progress', { taskId: 't1', progress: { text: 'working on it' } });
    bus.emit('task.progress', { taskId: 't1', progress: { text: 'almost there' } });
    bus.emit('task.done', { task: { result: { summary: 'All done: 3 files updated.' } } });
    await Promise.resolve();

    expect(provider.injected).toEqual(['working on it', 'All done: 3 files updated.']);
    await vi.advanceTimersByTimeAsync(60_000);
    // The superseded "almost there" is never spoken later.
    expect(provider.injected).toEqual(['working on it', 'All done: 3 files updated.']);
  });

  it('a fatal provider error tears down with a caption and an error state', async () => {
    const { bus, provider } = await startCascadeHost();

    provider.delegate!.onError(new Error('session dead'), { fatal: true });
    await micro();

    expect(provider.stopped).toBe(true);
    const captions = bus.sentOf('voice.transcript').map((p) => p.text);
    expect(captions.some((t) => String(t).includes('Voice connection lost'))).toBe(true);
    const states = bus.sentOf('voice.state').map((p) => p.state);
    expect(states[states.length - 1]).toBe('error');
  });
});
