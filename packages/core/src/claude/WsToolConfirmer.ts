import type { WsServer } from '../ws/server.js';
import { daemonEnvelopeContext } from '../util/ids.js';
import { makeEnvelope, isKind, type WsEnvelope } from '@workerking/shared';
import type { ToolConfirmer } from './toolPolicy.js';

/**
 * Requests destructive-tool approval from a connected UI client and awaits the
 * reply, reusing the same request/reply round-trip as screen capture.
 *
 * Fail-closed: if no chat client is connected, or none answers before the
 * timeout, the tool is denied. "Treat the voice port as an unauthenticated
 * houseguest." Only the chat window handles `tool.confirm_request` today (it
 * shows a visible prompt); the overlay renderer has no handler, so falling
 * back to it would just wait out the full timeout before denying anyway.
 */
export class WsToolConfirmer implements ToolConfirmer {
  constructor(
    private readonly server: WsServer,
    private readonly timeoutMs = 120_000,
  ) {}

  async confirm(req: { tool: string; summary: string }): Promise<boolean> {
    const client = this.server.findClient((c) => c.role === 'chat');
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
