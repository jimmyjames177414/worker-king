import {
  makeEnvelope,
  parseEnvelope,
  serializeEnvelope,
  type EnvelopeContext,
  type WsEnvelope,
  type WsMessageKind,
  type PayloadOf,
  type WsRole,
} from '@workerking/shared';

/** Browser EnvelopeContext: crypto.randomUUID + Date.now. */
const browserCtx: EnvelopeContext = {
  newId: () => crypto.randomUUID(),
  now: () => Date.now(),
};

export interface WsClientConnection {
  port: number;
  token: string;
  role: WsRole;
}

type Handler = (env: WsEnvelope) => void;

/**
 * Renderer-side WS client to the daemon. Performs the hello handshake, then
 * exposes send() and per-kind subscriptions. Auto-reconnects with backoff so a
 * daemon restart (or WSL localhost drop after sleep) heals transparently.
 */
export class WsClient {
  private ws?: WebSocket;
  private readonly handlers = new Map<WsMessageKind, Set<Handler>>();
  private readonly anyHandlers = new Set<Handler>();
  private reconnectDelay = 500;
  private closedByUser = false;
  private ready = false;
  private outbox: string[] = [];

  constructor(private readonly conn: WsClientConnection) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  /** Force a reconnect if the socket is dead (e.g. after system resume). No-op if healthy. */
  reconnect(): void {
    this.closedByUser = false;
    const state = this.ws?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(`ws://127.0.0.1:${this.conn.port}`);
    this.ws = ws;

    ws.addEventListener('open', () => {
      // Handshake first; the daemon replies with `welcome`.
      this.rawSend('hello', { role: this.conn.role, token: this.conn.token });
    });

    ws.addEventListener('message', (ev) => {
      let env: WsEnvelope;
      try {
        env = parseEnvelope(String(ev.data));
      } catch {
        return;
      }
      if (env.kind === 'welcome') {
        this.ready = true;
        this.reconnectDelay = 500;
        this.flush();
      }
      for (const h of this.handlers.get(env.kind) ?? []) h(env);
      for (const h of this.anyHandlers) h(env);
    });

    ws.addEventListener('close', () => {
      this.ready = false;
      if (!this.closedByUser) this.scheduleReconnect();
    });
    ws.addEventListener('error', () => ws.close());
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      if (!this.closedByUser) this.open();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
  }

  private rawSend<K extends WsMessageKind>(
    kind: K,
    payload: PayloadOf<K>,
    opts?: { replyTo?: string },
  ): void {
    const wire = serializeEnvelope(makeEnvelope(browserCtx, kind, payload, opts));
    this.ws?.send(wire);
  }

  send<K extends WsMessageKind>(
    kind: K,
    payload: PayloadOf<K>,
    opts?: { replyTo?: string },
  ): void {
    const wire = serializeEnvelope(makeEnvelope(browserCtx, kind, payload, opts));
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(wire);
    else this.outbox.push(wire); // buffered until welcome
  }

  private flush(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const wire of this.outbox.splice(0)) this.ws.send(wire);
  }

  on<K extends WsMessageKind>(kind: K, handler: (env: WsEnvelope<K>) => void): () => void {
    const set = this.handlers.get(kind) ?? new Set();
    set.add(handler as Handler);
    this.handlers.set(kind, set);
    return () => set.delete(handler as Handler);
  }

  /**
   * Send a message and await the reply whose `replyTo` matches its id
   * (e.g. voice.tool_call → voice.tool_result). Rejects on timeout.
   */
  request<K extends WsMessageKind>(
    kind: K,
    payload: PayloadOf<K>,
    timeoutMs = 20000,
  ): Promise<WsEnvelope> {
    const env = makeEnvelope(browserCtx, kind, payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`request "${kind}" timed out`));
      }, timeoutMs);
      const off = this.onAny((reply) => {
        if (reply.replyTo === env.id) {
          clearTimeout(timer);
          off();
          resolve(reply);
        }
      });
      const wire = serializeEnvelope(env);
      if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(wire);
      else this.outbox.push(wire);
    });
  }

  onAny(handler: Handler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }
}

/** Resolve the daemon connection from the preload bridge and build a client. */
export async function connectToDaemon(): Promise<WsClient> {
  const bridge = (window as unknown as {
    workerking?: { getConnection(): Promise<WsClientConnection | undefined> };
  }).workerking;
  if (!bridge) throw new Error('workerking preload bridge missing');
  const conn = await bridge.getConnection();
  if (!conn) throw new Error('no daemon connection available');
  const client = new WsClient(conn);
  client.connect();
  return client;
}
