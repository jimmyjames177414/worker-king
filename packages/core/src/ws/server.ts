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
  private wss?: WebSocketServer;
  private handler?: MessageHandler;
  private readonly clients = new Map<string, WsClient>();
  private readonly replyHandlers = new Map<string, (env: WsEnvelope) => void>();
  private connSeq = 0;

  constructor(opts: WsServerOptions) {
    this.token = opts.token ?? newToken();
    this.host = opts.host;
    this.daemonVersion = opts.daemonVersion;
    this.address = opts.address ?? '127.0.0.1';
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
      const wss = new WebSocketServer({ host: this.address, port });
      this.wss = wss;
      wss.on('error', reject);
      wss.on('listening', () => {
        const addr = wss.address() as AddressInfo;
        resolve(addr.port);
      });
      wss.on('connection', (socket) => this.handleConnection(socket));
    });
  }

  private handleConnection(socket: WebSocket): void {
    // Until a valid hello arrives, the socket is unauthenticated: no registry
    // entry, and only `hello` is accepted.
    let client: WsClient | undefined;

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
        client = this.registerClient(socket, env.payload.role);
        client.send('welcome', {
          connectionId: client.connectionId,
          daemonVersion: this.daemonVersion,
          host: this.host,
        });
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
      if (client) this.clients.delete(client.connectionId);
    });
    socket.on('error', () => {
      if (client) this.clients.delete(client.connectionId);
    });
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
    return client;
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
      for (const c of this.clients.values()) c.raw.close(1001, 'shutdown');
      this.clients.clear();
      if (this.wss) this.wss.close(() => resolve());
      else resolve();
    });
  }
}
