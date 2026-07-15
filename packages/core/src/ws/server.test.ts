import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import {
  makeEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type EnvelopeContext,
  type WsEnvelope,
} from '@workerking/shared';
import { WsServer, runHeartbeat, type WsClient, type HeartbeatEntry } from './server.js';

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

function fakeEntry(alive: boolean): HeartbeatEntry & { pinged: number; terminated: number } {
  return {
    alive,
    pinged: 0,
    terminated: 0,
    ping() {
      this.pinged++;
      this.alive = true; // fakes an immediate pong for the "stays alive" case
    },
    terminate() {
      this.terminated++;
    },
  };
}

describe('runHeartbeat', () => {
  it('pings live entries and marks them pending', () => {
    const live = fakeEntry(true);
    // Custom ping that does NOT auto-revive, to observe the pending flip.
    live.ping = function () {
      this.pinged++;
    };
    const dropped = runHeartbeat(new Map([['a', live]]));
    expect(dropped).toEqual([]);
    expect(live.pinged).toBe(1);
    expect(live.alive).toBe(false); // pending until a pong arrives
  });

  it('reaps an entry that did not answer since the last round', () => {
    const silent = fakeEntry(false);
    const dropped = runHeartbeat(new Map([['dead', silent]]));
    expect(dropped).toEqual(['dead']);
    expect(silent.terminated).toBe(1);
  });

  it('reaps only the silent peer across two rounds', () => {
    const responsive = fakeEntry(true); // its ping() revives it each round
    const silent = fakeEntry(true);
    silent.ping = function () {
      this.pinged++; // never revives → silent next round
    };
    const entries = new Map<string, HeartbeatEntry>([
      ['live', responsive],
      ['dead', silent],
    ]);
    expect(runHeartbeat(entries)).toEqual([]); // round 1: both pinged
    // Simulate the map-removal the server does for dropped ids.
    for (const id of runHeartbeat(entries)) entries.delete(id);
    expect([...entries.keys()]).toEqual(['live']);
  });
});

describe('WsServer heartbeat integration', () => {
  it('keeps a responsive client after a sweep', async () => {
    const server = new WsServer({ token: 'tok', host: 'windows', daemonVersion: '0', heartbeatMs: 0 });
    const port = await server.start(0);
    const c = connect(port, 'tok');
    await c.next(); // welcome
    expect(server.clientCount()).toBe(1);
    server.heartbeatSweep(); // pings; real client auto-pongs, so it survives
    expect(server.clientCount()).toBe(1);
    c.close();
    await server.close();
  });
});
