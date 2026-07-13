import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import {
  makeEnvelope,
  parseEnvelope,
  serializeEnvelope,
  isKind,
  type EnvelopeContext,
} from '@workerking/shared';
import { WsServer } from '../ws/server.js';
import { WsScreenContextProvider } from './ScreenContextProvider.js';

let seq = 0;
const ctx: EnvelopeContext = { newId: () => `t-${++seq}`, now: () => Date.now() };

describe('WsScreenContextProvider round-trip', () => {
  let server: WsServer;
  let port: number;

  beforeAll(async () => {
    server = new WsServer({ token: 'tok', host: 'windows', daemonVersion: '0' });
    port = await server.start(0);
  });
  afterAll(async () => {
    await server.close();
  });

  it('returns an error when no main is connected', async () => {
    const provider = new WsScreenContextProvider(server, 500);
    const ctxResult = await provider.capture({ target: 'window', includeImage: false });
    expect(ctxResult.ok).toBe(false);
    expect(ctxResult.error).toMatch(/no electron main/i);
  });

  it('round-trips a capture request to a connected main client', async () => {
    // Connect a fake "main" that answers capture requests.
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () =>
        ws.send(serializeEnvelope(makeEnvelope(ctx, 'hello', { role: 'main', token: 'tok' }))),
      );
      ws.on('message', (d) => {
        const env = parseEnvelope(d.toString());
        if (env.kind === 'welcome') resolve();
        if (isKind(env, 'screen.capture_request')) {
          ws.send(
            serializeEnvelope(
              makeEnvelope(
                ctx,
                'screen.capture_result',
                {
                  ok: true,
                  activeWindowTitle: 'report.pdf — Reader',
                  imageDataUrl: 'data:image/png;base64,QUJD',
                },
                { replyTo: env.id },
              ),
            ),
          );
        }
      });
      ws.on('error', reject);
    });

    const provider = new WsScreenContextProvider(server, 3000);
    const result = await provider.capture({ target: 'window', includeImage: true });
    expect(result.ok).toBe(true);
    expect(result.activeWindowTitle).toBe('report.pdf — Reader');
    // data: prefix stripped, leaving raw base64.
    expect(result.imageBase64).toBe('QUJD');

    ws.close();
  });
});
