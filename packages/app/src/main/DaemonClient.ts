import { WebSocket } from 'ws';
import {
  makeEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type EnvelopeContext,
  type WsEnvelope,
  type WsMessageKind,
  type PayloadOf,
} from '@workerking/shared';
import { randomUUID } from 'node:crypto';
import type { DaemonConnection } from './DaemonSupervisor.js';

const ctx: EnvelopeContext = { newId: () => randomUUID(), now: () => Date.now() };

/**
 * Main-process WS client to the daemon (role 'main').
 *
 * Electron main connects to the daemon so it can service requests that only main
 * can fulfill — currently `screen.capture_request` (screenshots + foreground
 * window title happen in the Windows GUI process, even when the daemon lives in
 * WSL). Reconnects with backoff so a daemon restart heals transparently.
 */
export class DaemonClient {
  private ws?: WebSocket;
  private closedByUser = false;
  private reconnectDelay = 500;
  private readonly handlers = new Map<WsMessageKind, (env: WsEnvelope) => void>();

  constructor(private readonly conn: DaemonConnection) {}

  on<K extends WsMessageKind>(kind: K, handler: (env: WsEnvelope<K>) => void): void {
    this.handlers.set(kind, handler as (env: WsEnvelope) => void);
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(`ws://127.0.0.1:${this.conn.port}`);
    this.ws = ws;
    ws.on('open', () => {
      this.send('hello', { role: 'main', token: this.conn.token });
    });
    ws.on('message', (data) => {
      let env: WsEnvelope;
      try {
        env = parseEnvelope(data.toString());
      } catch {
        return;
      }
      if (env.kind === 'welcome') this.reconnectDelay = 500;
      const handler = this.handlers.get(env.kind);
      if (handler) handler(env);
    });
    ws.on('close', () => {
      if (!this.closedByUser) this.scheduleReconnect();
    });
    ws.on('error', () => ws.close());
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      if (!this.closedByUser) this.open();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
  }

  send<K extends WsMessageKind>(
    kind: K,
    payload: PayloadOf<K>,
    opts?: { replyTo?: string },
  ): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(serializeEnvelope(makeEnvelope(ctx, kind, payload, opts)));
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }
}
