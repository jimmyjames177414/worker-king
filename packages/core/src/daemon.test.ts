import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { startDaemon, createDaemonDeps, type RunningDaemon } from './main.js';
import { ConfigStore } from './config/ConfigStore.js';
import { MemoryStore } from './memory/MemoryStore.js';
import { InteractionLog } from './memory/InteractionLog.js';
import { ConversationStore } from './history/ConversationStore.js';
import { WatchStore } from './proactive/WatchStore.js';
import { ReminderStore } from './proactive/ReminderStore.js';
import { TaskStore } from './tasks/TaskStore.js';

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
  let dir: string;

  beforeAll(async () => {
    // Pin to the echo brain so these tests don't attempt to spawn Claude Code,
    // and point every store (and the config) at a temp dir — a test must never
    // read or mutate the developer's real ~/.claude/workerking state.
    dir = mkdtempSync(join(tmpdir(), 'wk-daemon-test-'));
    daemon = await startDaemon({
      port: 0,
      token: 'test-token',
      brainMode: 'echo',
      config: new ConfigStore(), // in-memory, no persistence
      deps: createDaemonDeps({
        memory: new MemoryStore({ dir }),
        interactionLog: new InteractionLog({ dir }),
        conversations: new ConversationStore({ dir }),
        watchStore: new WatchStore({ dir }),
        reminderStore: new ReminderStore({ dir }),
        taskStore: new TaskStore({ dir }),
      }),
    });
  });

  afterAll(async () => {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
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

  it('delegates a voice tool call and streams task.* to completion', async () => {
    const c = await MockClient.connect(daemon.port, daemon.token, 'overlay');
    c.send('voice.tool_call', { name: 'delegate_to_worker', args: { task: 'rename my files' } });

    // Collect the whole exchange up to completion (order: task.created broadcast,
    // voice.tool_result reply, then async task.* as the echo brain runs).
    const envs = await c.collectUntil('task.done');

    const result = envs.find((e) => e.kind === 'voice.tool_result') as
      WsEnvelope<'voice.tool_result'> | undefined;
    const payload = result?.payload.result as { status: string; task_id: string };
    expect(payload.status).toBe('started');
    expect(payload.task_id).toBeTruthy();

    expect(envs.find((e) => e.kind === 'task.created')).toBeDefined();
    const done = envs.find((e) => e.kind === 'task.done') as WsEnvelope<'task.done'> | undefined;
    expect(done?.payload.task.state).toBe('done');
    expect(done?.payload.task.result?.summary).toContain('Echo task complete');
    c.close();
  });

  it('rejects an unknown voice tool', async () => {
    const c = await MockClient.connect(daemon.port, daemon.token, 'overlay');
    c.send('voice.tool_call', { name: 'nonsense', args: {} });
    const envs = await c.collectUntil('voice.tool_result');
    const result = envs.find((e) => e.kind === 'voice.tool_result') as
      WsEnvelope<'voice.tool_result'> | undefined;
    expect(result?.payload.isError).toBe(true);
    c.close();
  });
});
