import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import {
  makeEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type WsEnvelope,
  type WsMessageKind,
  type PayloadOf,
  type EnvelopeContext,
} from '@workerking/shared';
import { startDaemon, type RunningDaemon } from './main.js';

let seq = 0;
const ctx: EnvelopeContext = {
  newId: () => `test-${++seq}`,
  now: () => Date.now(),
};

/**
 * Minimal mock client: connects, performs the hello handshake, and lets tests
 * send a kind and await the next envelope(s) of an expected kind.
 */
class MockClient {
  private ws!: WebSocket;
  private inbox: WsEnvelope[] = [];
  private waiters: Array<(env: WsEnvelope) => void> = [];

  static async connect(port: number, token: string, role: 'chat' | 'overlay'): Promise<MockClient> {
    const c = new MockClient();
    await c.open(port, token, role);
    return c;
  }

  private open(port: number, token: string, role: 'chat' | 'overlay'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
      this.ws.on('message', (data) => {
        const env = parseEnvelope(data.toString());
        const waiter = this.waiters.shift();
        if (waiter) waiter(env);
        else this.inbox.push(env);
      });
      this.ws.on('error', reject);
      this.ws.on('open', () => {
        this.send('hello', { role, token });
        // Wait for welcome before resolving.
        this.next().then((env) => {
          if (env.kind === 'welcome') resolve();
          else reject(new Error(`expected welcome, got ${env.kind}`));
        });
      });
    });
  }

  send<K extends WsMessageKind>(kind: K, payload: PayloadOf<K>, opts?: { replyTo?: string }): void {
    this.ws.send(serializeEnvelope(makeEnvelope(ctx, kind, payload, opts)));
  }

  next(): Promise<WsEnvelope> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Collect envelopes until one of `untilKind` arrives (inclusive). */
  async collectUntil(untilKind: WsMessageKind): Promise<WsEnvelope[]> {
    const out: WsEnvelope[] = [];
    for (;;) {
      const env = await this.next();
      out.push(env);
      if (env.kind === untilKind) return out;
    }
  }

  close(): void {
    this.ws.close();
  }
}

describe('core daemon (Phase 0)', () => {
  let daemon: RunningDaemon;

  beforeAll(async () => {
    daemon = await startDaemon({ port: 0, token: 'test-token' });
  });

  afterAll(async () => {
    await daemon.stop();
  });

  it('accepts a valid hello and sends welcome with host info', async () => {
    const c = await MockClient.connect(daemon.port, daemon.token, 'chat');
    // welcome was already consumed during connect; a fresh ping proves the
    // authenticated channel works.
    c.send('ping', {});
    const pong = await c.next();
    expect(pong.kind).toBe('pong');
    c.close();
  });

  it('rejects an invalid token', async () => {
    const c = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
    const result = await new Promise<WsEnvelope>((resolve, reject) => {
      c.on('open', () => {
        c.send(serializeEnvelope(makeEnvelope(ctx, 'hello', { role: 'chat', token: 'WRONG' })));
      });
      c.on('message', (d) => resolve(parseEnvelope(d.toString())));
      c.on('error', reject);
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.payload.code).toBe('auth_error');
    }
    c.close();
  });

  it('echoes a chat.user_message as streamed deltas + done', async () => {
    const c = await MockClient.connect(daemon.port, daemon.token, 'chat');
    c.send('chat.user_message', { text: 'hello world', messageId: 'm1' });

    const envs = await c.collectUntil('chat.assistant_done');
    const deltas = envs.filter((e) => e.kind === 'chat.assistant_delta');
    const done = envs.find((e) => e.kind === 'chat.assistant_done');

    expect(deltas.length).toBeGreaterThan(0);
    const streamed = deltas
      .map((e) => (e as WsEnvelope<'chat.assistant_delta'>).payload.delta)
      .join('');
    expect(streamed).toBe('You said: hello world');

    expect(done).toBeDefined();
    const donePayload = (done as WsEnvelope<'chat.assistant_done'>).payload;
    expect(donePayload.text).toBe('You said: hello world');
    expect(donePayload.messageId).toBe('m1');
    c.close();
  });

  it('sets and broadcasts config changes', async () => {
    const c = await MockClient.connect(daemon.port, daemon.token, 'chat');
    c.send('config.set', { key: 'assistantName', value: 'Jarvis' });
    const changed = await c.next();
    expect(changed.kind).toBe('config.changed');
    if (changed.kind === 'config.changed') {
      expect(changed.payload.key).toBe('assistantName');
      expect(changed.payload.value).toBe('Jarvis');
    }
    c.close();
  });
});
