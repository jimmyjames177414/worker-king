import { describe, it, expect } from 'vitest';
import type { WsServer, WsClient, MessageHandler } from '../ws/server.js';
import type { WsEnvelope, PayloadOf, WsMessageKind } from '@workerking/shared';
import { ConfigStore } from '../config/ConfigStore.js';
import type { Brain } from '../brain/Brain.js';
import type { TaskRunEvents } from '../tasks/TaskManager.js';
import { Supervisor } from './Supervisor.js';

/** Minimal fake WsServer: just enough surface for the Supervisor to route messages. */
function fakeServer() {
  let handler: MessageHandler | undefined;
  return {
    onMessage: (h: MessageHandler) => {
      handler = h;
    },
    broadcast: () => {},
    findClient: () => undefined,
    onceReply: () => () => {},
    // Test helper, not part of the real WsServer surface.
    dispatch(client: WsClient, env: WsEnvelope) {
      handler?.(client, env);
    },
  };
}

function fakeClient(id: string): WsClient & { sent: Array<{ kind: string; payload: unknown }> } {
  const sent: Array<{ kind: string; payload: unknown }> = [];
  return {
    connectionId: id,
    role: 'chat',
    raw: {} as WsClient['raw'],
    sent,
    send: <K extends WsMessageKind>(kind: K, payload: PayloadOf<K>) => {
      sent.push({ kind, payload });
    },
  };
}

/** A brain whose `respond` resolves after a tick and records concurrent calls. */
function fakeBrain(): Brain & { maxConcurrent: number } {
  let inFlight = 0;
  const state = {
    maxConcurrent: 0,
  };
  return {
    id: 'fake',
    async respond(text: string, onDelta: (delta: string) => void): Promise<string> {
      inFlight++;
      state.maxConcurrent = Math.max(state.maxConcurrent, inFlight);
      // Yield a couple of microtask turns so a second concurrent call (if the
      // Supervisor didn't serialize) would overlap this one.
      await new Promise((r) => setTimeout(r, 5));
      onDelta(text);
      inFlight--;
      return text;
    },
    async run(_prompt: string, _events: TaskRunEvents, _signal: AbortSignal): Promise<void> {},
    get maxConcurrent() {
      return state.maxConcurrent;
    },
  };
}

describe('Supervisor.handleChat serialization', () => {
  it('never runs brain.respond for two turns concurrently', async () => {
    const server = fakeServer();
    const brain = fakeBrain();
    new Supervisor(server as unknown as WsServer, new ConfigStore(), brain);
    const client = fakeClient('c1');

    // Fire two chat turns back-to-back, before either has a chance to resolve.
    server.dispatch(client, {
      v: 1,
      id: 'turn-1',
      kind: 'chat.user_message',
      ts: 0,
      payload: { text: 'first', messageId: 'm1' },
    } as WsEnvelope<'chat.user_message'>);
    server.dispatch(client, {
      v: 1,
      id: 'turn-2',
      kind: 'chat.user_message',
      ts: 0,
      payload: { text: 'second', messageId: 'm2' },
    } as WsEnvelope<'chat.user_message'>);

    // Give both turns time to fully complete.
    await new Promise((r) => setTimeout(r, 50));

    expect(brain.maxConcurrent).toBe(1);
    const done = client.sent.filter((s) => s.kind === 'chat.assistant_done');
    expect(done).toHaveLength(2);
    expect((done[0].payload as { messageId: string }).messageId).toBe('m1');
    expect((done[1].payload as { messageId: string }).messageId).toBe('m2');
  });
});
