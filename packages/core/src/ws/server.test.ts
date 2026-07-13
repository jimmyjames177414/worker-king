import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import {
  makeEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type EnvelopeContext,
  type WsEnvelope,
} from '@workerking/shared';
import { WsServer, type WsClient } from './server.js';

let seq = 0;
const ctx: EnvelopeContext = { newId: () => `s-${++seq}`, now: () => 1 };

/** Minimal client that handshakes and lets the test pull the next envelope. */
function connect(port: number, token: string): { next(): Promise<WsEnvelope>; close(): void } {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: WsEnvelope[] = [];
  const waiters: Array<(e: WsEnvelope) => void> = [];
  ws.on('message', (d) => {
    const env = parseEnvelope(d.toString());
    const w = waiters.shift();
    if (w) w(env);
    else inbox.push(env);
  });
  ws.on('open', () =>
    ws.send(serializeEnvelope(makeEnvelope(ctx, 'hello', { role: 'overlay', token }))),
  );
  return {
    next: () =>
      new Promise<WsEnvelope>((resolve) => {
        const e = inbox.shift();
        if (e) resolve(e);
        else waiters.push(resolve);
      }),
    close: () => ws.close(),
  };
}

describe('WsServer.onClientConnected + buffered flush', () => {
  let server: WsServer;
  let port: number;
  const connected: WsClient[] = [];
  const buffer: string[] = [];

  beforeAll(async () => {
    server = new WsServer({ token: 'tok', host: 'windows', daemonVersion: '0' });
    // Mirror main.ts's buffer-and-flush: queue when no clients, flush on connect.
    server.onClientConnected(() => {
      for (const text of buffer.splice(0)) server.broadcast('proactive.notify', { text });
    });
    server.onClientConnected((c) => connected.push(c));
    port = await server.start(0);
  });
  afterAll(async () => {
    await server.close();
  });

  it('flushes a buffered notice to a client that connects after it was queued', async () => {
    expect(server.clientCount()).toBe(0);
    // Queue a notice while nobody is connected (e.g. a reminder fired while the UI was closed).
    buffer.push('reminder while UI was closed');

    const c = connect(port, 'tok');
    const welcome = await c.next();
    expect(welcome.kind).toBe('welcome'); // welcome first
    expect(connected.length).toBeGreaterThan(0);

    // Then the buffered notice is flushed to the freshly-connected client.
    const notice = await c.next();
    expect(notice.kind).toBe('proactive.notify');
    if (notice.kind === 'proactive.notify') {
      expect(notice.payload.text).toBe('reminder while UI was closed');
    }
    c.close();
  });
});
