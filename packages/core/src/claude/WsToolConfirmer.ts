import type { WsServer } from '../ws/server.js';
import { daemonEnvelopeContext } from '../util/ids.js';
import { makeEnvelope, isKind, type WsEnvelope } from '@workerking/shared';
import type { ToolConfirmer } from './toolPolicy.js';

/**
 * Requests destructive-tool approval from a connected UI client and awaits the
 * reply, reusing the same request/reply round-trip as screen capture. Prefers the
 * chat window (it shows a visible prompt); falls back to the overlay.
 *
 * Fail-closed: if no UI client is connected, or none answers before the timeout,
 * the tool is denied. "Treat the voice port as an unauthenticated houseguest."
 */
export class WsToolConfirmer implements ToolConfirmer {
  constructor(
    private readonly server: WsServer,
    private readonly timeoutMs = 120_000,
  ) {}

  async confirm(req: { tool: string; summary: string }): Promise<boolean> {
    const client =
      this.server.findClient((c) => c.role === 'chat') ??
      this.server.findClient((c) => c.role === 'overlay');
    if (!client) return false; // nobody to approve → deny

    const request = makeEnvelope(daemonEnvelopeContext, 'tool.confirm_request', {
      tool: req.tool,
      summary: req.summary,
    });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        dispose();
        resolve(false);
      }, this.timeoutMs);

      const dispose = this.server.onceReply(request.id, (reply: WsEnvelope) => {
        clearTimeout(timer);
        resolve(isKind(reply, 'tool.confirm_response') ? reply.payload.approved === true : false);
      });

      client.raw.send(JSON.stringify(request));
    });
  }
}
