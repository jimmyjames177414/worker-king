import { describe, it, expect, vi } from 'vitest';
import type { WsServer, WsClient } from '../ws/server.js';
import { WsToolConfirmer } from './WsToolConfirmer.js';
import { makeEnvelope, type WsEnvelope } from '@workerking/shared';
import { daemonEnvelopeContext } from '../util/ids.js';

function fakeClient(role: 'chat' | 'overlay' = 'chat') {
  return {
    connectionId: 'c1',
    role,
    raw: { send: vi.fn() } as unknown as WsClient['raw'],
    send: vi.fn(),
  } as WsClient;
}

/** A fake WsServer whose onceReply captures the handler so a test can invoke it. */
function fakeServer(client: WsClient | undefined) {
  let replyHandler: ((env: WsEnvelope) => void) | undefined;
  const server = {
    findClient: () => client,
    onceReply: (_requestId: string, handler: (env: WsEnvelope) => void) => {
      replyHandler = handler;
      return () => {};
    },
  } as unknown as WsServer;
  return {
    server,
    reply: (env: WsEnvelope) => replyHandler?.(env),
  };
}

describe('WsToolConfirmer', () => {
  it('denies immediately when no chat client is connected', async () => {
    const { server } = fakeServer(undefined);
    const confirmer = new WsToolConfirmer(server);
    await expect(confirmer.confirm({ tool: 'Bash', summary: 'rm -rf /' })).resolves.toBe(false);
  });

  it('denies when nobody replies before the timeout', async () => {
    vi.useFakeTimers();
    try {
      const { server } = fakeServer(fakeClient());
      const confirmer = new WsToolConfirmer(server, 50);
      const pending = confirmer.confirm({ tool: 'Bash', summary: 'rm -rf /' });
      let settled: boolean | undefined;
      void pending.then((v) => (settled = v));
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('denies a malformed reply (wrong envelope kind)', async () => {
    const { server, reply } = fakeServer(fakeClient());
    const confirmer = new WsToolConfirmer(server);
    const pending = confirmer.confirm({ tool: 'Bash', summary: 'rm -rf /' });
    reply(makeEnvelope(daemonEnvelopeContext, 'ping', {}) as unknown as WsEnvelope);
    await expect(pending).resolves.toBe(false);
  });

  it('denies a tool.confirm_response with approved: false', async () => {
    const { server, reply } = fakeServer(fakeClient());
    const confirmer = new WsToolConfirmer(server);
    const pending = confirmer.confirm({ tool: 'Bash', summary: 'rm -rf /' });
    reply(makeEnvelope(daemonEnvelopeContext, 'tool.confirm_response', { approved: false }));
    await expect(pending).resolves.toBe(false);
  });

  it('approves a well-formed tool.confirm_response with approved: true', async () => {
    const { server, reply } = fakeServer(fakeClient());
    const confirmer = new WsToolConfirmer(server);
    const pending = confirmer.confirm({ tool: 'Bash', summary: 'rm -rf /' });
    reply(makeEnvelope(daemonEnvelopeContext, 'tool.confirm_response', { approved: true }));
    await expect(pending).resolves.toBe(true);
  });
});
