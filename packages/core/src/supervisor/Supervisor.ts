import type { WsServer, WsClient } from '../ws/server.js';
import type { WsEnvelope } from '@workerking/shared';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { Brain } from '../brain/Brain.js';

/**
 * Supervisor — the daemon's message router.
 *
 * In Phase 0 it wires two paths:
 *  - chat.user_message -> Brain.respond -> streamed chat.assistant_delta + chat.assistant_done
 *  - config.get / config.set -> ConfigStore (+ config.changed broadcast)
 *
 * Later phases add the voice.tool_call router (delegate_to_worker etc.), the
 * TaskManager, and capability manifest broadcasts — all hung off this same class.
 */
export class Supervisor {
  constructor(
    private readonly server: WsServer,
    private readonly config: ConfigStore,
    private readonly brain: Brain,
  ) {
    this.server.onMessage((client, env) => {
      // Route by kind; unknown kinds are ignored (forward-compatible).
      void this.dispatch(client, env);
    });

    // Rebroadcast config changes to every client (renderers keep settings live).
    this.config.onChange((key, value) => {
      this.server.broadcast('config.changed', { key, value });
    });
  }

  private async dispatch(client: WsClient, env: WsEnvelope): Promise<void> {
    switch (env.kind) {
      case 'chat.user_message':
        return this.handleChat(client, env as WsEnvelope<'chat.user_message'>);
      case 'config.get':
        return this.handleConfigGet(client, env as WsEnvelope<'config.get'>);
      case 'config.set':
        return this.handleConfigSet(env as WsEnvelope<'config.set'>);
      default:
        // Not handled in this phase.
        return;
    }
  }

  private async handleChat(
    client: WsClient,
    env: WsEnvelope<'chat.user_message'>,
  ): Promise<void> {
    const { text, messageId } = env.payload;
    try {
      const full = await this.brain.respond(text, (delta) => {
        client.send('chat.assistant_delta', { messageId, delta });
      });
      client.send('chat.assistant_done', { messageId, text: full });
    } catch (err) {
      client.send('error', {
        message: `Brain failed: ${String(err)}`,
        code: 'brain_error',
      });
    }
  }

  private handleConfigGet(client: WsClient, env: WsEnvelope<'config.get'>): void {
    const { key } = env.payload;
    const value = key ? this.config.get(key) : this.config.get();
    // Reply reuses config.changed as the response shape for a single key,
    // or emits per-key for a full dump.
    if (key) {
      client.send('config.changed', { key, value }, { replyTo: env.id });
    } else {
      const all = value as Record<string, unknown>;
      for (const [k, v] of Object.entries(all)) {
        client.send('config.changed', { key: k, value: v });
      }
    }
  }

  private handleConfigSet(env: WsEnvelope<'config.set'>): void {
    const { key, value } = env.payload;
    this.config.set(key, value); // triggers config.changed broadcast via onChange
  }
}
