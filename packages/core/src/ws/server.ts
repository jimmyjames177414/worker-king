import { WebSocketServer, WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import {
  makeEnvelope,
  parseEnvelope,
  serializeEnvelope,
  ProtocolError,
  isKind,
  type WsEnvelope,
  type WsMessageKind,
  type PayloadOf,
  type WsRole,
} from '@workerking/shared';
import { daemonEnvelopeContext, newToken } from '../util/ids.js';

/**
 * A connected client, from the daemon's point of view.
 * Populated after a valid `hello` handshake.
 */
export interface WsClient {
  connectionId: string;
  role: WsRole;
  send<K extends WsMessageKind>(kind: K, payload: PayloadOf<K>, opts?: { replyTo?: string }): void;
  raw: WebSocket;
}

export type MessageHandler = (client: WsClient, env: WsEnvelope) => void;

export interface WsServerOptions {
  /** Shared secret clients must present in `hello`. Generated if omitted. */
  token?: string;
  host: 'windows' | 'wsl' | 'unknown';
  daemonVersion: string;
  /** Bind address. Defaults to loopback only. */
  address?: string;
  /** Heartbeat interval (ms). 0 disables. Defaults to 30_000. */
  heartbeatMs?: number;
}

/** One heartbeat entry: liveness plus the socket controls the sweep needs. */
export interface HeartbeatEntry {
  alive: boolean;
  ping(): void;
  terminate(): void;
}

/**
 * Run one heartbeat round over the entries. Any entry that hasn't answered since
 * the last round (`alive === false`) is terminated and its id returned for
 * removal; the rest are marked pending and pinged. Native ws auto-replies to the
 * ping with a pong, which flips `alive` back to true before the next round — so a
 * half-open socket (e.g. a WSL localhost drop after sleep) is reaped instead of
 * lingering in the registry forever. Pure/synchronous for testability.
 */
export function runHeartbeat(entries: Map<string, HeartbeatEntry>): string[] {
  const dropped: string[] = [];
  for (const [id, e] of entries) {
    if (!e.alive) {
      e.terminate();
      dropped.push(id);
      continue;
    }
    e.alive = false;
    e.ping();
  }
  return dropped;
}

/**
 * The daemon's WebSocket server. Binds loopback-only, authenticates every client
 * via a one-time token in the `hello` handshake, and dispatches validated
 * envelopes to a single message handler (the Supervisor).
 */
export class WsServer {
  readonly token: string;
  private readonly host: 'windows' | 'wsl' | 'unknown';
  private readonly daemonVersion: string;
  private readonly address: string;
  private readonly heartbeatMs: number;
  private wss?: WebSocketServer;
  private handler?: MessageHandler;
  private readonly clients = new Map<string, WsClient>();
  private readonly heartbeats = new Map<string, HeartbeatEntry>();
  private readonly replyHandlers = new Map<string, (env: WsEnvelope) => void>();
  private readonly clientConnectedHandlers = new Set<(client: WsClient) => void>();
  private connSeq = 0;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(opts: WsServerOptions) {
    this.token = opts.token ?? newToken();
    this.host = opts.host;
    this.daemonVersion = opts.daemonVersion;
    this.address = opts.address ?? '127.0.0.1';
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Find the first connected client matching a predicate (e.g. role === 'main'). */
  findClient(pred: (c: WsClient) => boolean): WsClient | undefined {
    for (const c of this.clients.values()) if (pred(c)) return c;
    return undefined;
  }

  /**
   * Register a one-shot handler for the reply to `requestId` (a message whose
   * `replyTo` equals it). Returns a dispose function to cancel the wait.
   */
  onceReply(requestId: string, handler: (env: WsEnvelope) => void): () => void {
    this.replyHandlers.set(requestId, handler);
    return () => this.replyHandlers.delete(requestId);
  }

  /** Start listening. Pass 0 (default) for an OS-assigned ephemeral port. */
  start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      // Cap inbound frames (N11): generous enough for base64 screenshots, but
      // bounded so a malformed/hostile peer can't force a huge allocation.
      const wss = new WebSocketServer({ host: this.address, port, maxPayload: 16 * 1024 * 1024 });
      this.wss = wss;
      wss.on('error', reject);
      wss.on('listening', () => {
        const addr = wss.address() as AddressInfo;
        resolve(addr.port);
      });
      wss.on('connection', (socket) => this.handleConnection(socket));
      if (this.heartbeatMs > 0) {
        this.heartbeatTimer = setInterval(() => this.heartbeatSweep(), this.heartbeatMs);
        this.heartbeatTimer.unref?.(); // never keep the process alive on our own
      }
    });
  }

  /** Run one heartbeat round, dropping any client that went silent. Public for tests. */
  heartbeatSweep(): void {
    for (const id of runHeartbeat(this.heartbeats)) {
      this.clients.delete(id);
      this.heartbeats.delete(id);
    }
  }

  private handleConnection(socket: WebSocket): void {
    // Until a valid hello arrives, the socket is unauthenticated: no registry
    // entry, and only `hello` is accepted.
    let client: WsClient | undefined;

    // Pre-hello sockets have no heartbeat entry, so without this bound a peer
    // that connects and never authenticates would hold its connection forever.
    const handshakeTimer = setTimeout(() => {
      if (!client) socket.terminate();
    }, 10_000);
    handshakeTimer.unref?.();

    socket.on('message', (data) => {
      let env: WsEnvelope;
      try {
        env = parseEnvelope(data.toString());
      } catch (err) {
        const code = err instanceof ProtocolError ? err.code : 'bad_envelope';
        this.sendRaw(socket, 'error', { message: String(err), code });
        return;
      }

      if (!client) {
        if (!isKind(env, 'hello')) {
          this.sendRaw(socket, 'error', {
            message: 'Expected hello handshake first',
            code: 'auth_error',
          });
          socket.close(4001, 'handshake required');
          return;
        }
        if (env.payload.token !== this.token) {
          this.sendRaw(socket, 'error', { message: 'Invalid token', code: 'auth_error' });
          socket.close(4003, 'invalid token');
          return;
        }
        clearTimeout(handshakeTimer);
        client = this.registerClient(socket, env.payload.role);
        client.send('welcome', {
          connectionId: client.connectionId,
          daemonVersion: this.daemonVersion,
          host: this.host,
        });
        // Notify listeners after welcome so any flushed messages arrive next.
        for (const cb of this.clientConnectedHandlers) cb(client);
        return;
      }

      // Authenticated message.
      if (env.kind === 'ping') {
        client.send('pong', {}, { replyTo: env.id });
        return;
      }
      // Route replies (e.g. screen.capture_result) to a waiting requester.
      if (env.replyTo) {
        const rh = this.replyHandlers.get(env.replyTo);
        if (rh) {
          this.replyHandlers.delete(env.replyTo);
          rh(env);
          return;
        }
      }
      this.handler?.(client, env);
    });

    socket.on('close', () => {
      clearTimeout(handshakeTimer);
      if (client) this.dropClient(client.connectionId);
    });
    socket.on('error', () => {
      if (client) this.dropClient(client.connectionId);
    });
  }

  private dropClient(connectionId: string): void {
    this.clients.delete(connectionId);
    this.heartbeats.delete(connectionId);
  }

  private registerClient(socket: WebSocket, role: WsRole): WsClient {
    const connectionId = `conn-${++this.connSeq}`;
    const client: WsClient = {
      connectionId,
      role,
      raw: socket,
      send: (kind, payload, opts) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        socket.send(serializeEnvelope(makeEnvelope(daemonEnvelopeContext, kind, payload, opts)));
      },
    };
    this.clients.set(connectionId, client);
    this.heartbeats.set(connectionId, {
      alive: true,
      ping: () => {
        try {
          socket.ping();
        } catch {
          // socket dying mid-ping; the next sweep reaps it
        }
      },
      terminate: () => socket.terminate(),
    });
    // Native pong (auto-sent by ws in reply to our ping) proves the peer is alive.
    socket.on('pong', () => {
      const entry = this.heartbeats.get(connectionId);
      if (entry) entry.alive = true;
    });
    return client;
  }

  /** Fire `cb` whenever a client completes the handshake (used to flush buffered notices). */
  onClientConnected(cb: (client: WsClient) => void): () => void {
    this.clientConnectedHandlers.add(cb);
    return () => this.clientConnectedHandlers.delete(cb);
  }

  private sendRaw<K extends WsMessageKind>(
    socket: WebSocket,
    kind: K,
    payload: PayloadOf<K>,
  ): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(serializeEnvelope(makeEnvelope(daemonEnvelopeContext, kind, payload)));
  }

  /** Broadcast to all authenticated clients, optionally filtered by role. */
  broadcast<K extends WsMessageKind>(
    kind: K,
    payload: PayloadOf<K>,
    filter?: (c: WsClient) => boolean,
  ): void {
    for (const client of this.clients.values()) {
      if (!filter || filter(client)) client.send(kind, payload);
    }
  }

  clientCount(): number {
    return this.clients.size;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
      const sockets = [...this.clients.values()].map((c) => c.raw);
      for (const s of sockets) s.close(1001, 'shutdown');
      this.clients.clear();
      this.heartbeats.clear();
      // `wss.close` waits for every socket to finish its close handshake — a
      // dead peer would hang shutdown (and a second Ctrl-C would re-enter the
      // same hang). Force-terminate stragglers after a short grace period.
      const grace = setTimeout(() => {
        for (const s of sockets) s.terminate();
      }, 2000);
      grace.unref?.();
      if (this.wss) {
        this.wss.close(() => {
          clearTimeout(grace);
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
