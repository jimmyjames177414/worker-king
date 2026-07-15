import type { WsServer, WsClient } from '../ws/server.js';
import type { WsEnvelope } from '@workerking/shared';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { Brain } from '../brain/Brain.js';
import { TaskManager } from '../tasks/TaskManager.js';
import { daemonEnvelopeContext } from '../util/ids.js';
import type { InteractionLog } from '../memory/InteractionLog.js';
import type { ConversationStore } from '../history/ConversationStore.js';
import type { WatchStore } from '../proactive/WatchStore.js';
import { composeWatches } from '../proactive/ProactiveManager.js';
import type { Watch } from '@workerking/shared';
import type { Logger } from '../util/logger.js';

/** How the Supervisor manages proactive watches (persist + live reload). */
export interface WatchDeps {
  store: WatchStore;
  /** Reschedule the running ProactiveManager with the full watch set. */
  reload: (watches: Watch[]) => void;
}

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
  private readonly tasks: TaskManager;

  constructor(
    private readonly server: WsServer,
    private readonly config: ConfigStore,
    private readonly brain: Brain,
    private readonly log?: InteractionLog,
    private readonly history?: ConversationStore,
    private readonly watches?: WatchDeps,
    /** Structured logger for per-turn tracing (N8). */
    private readonly logger?: Logger,
  ) {
    // TaskManager drives delegated (voice) work; its events become task.* broadcasts.
    this.tasks = new TaskManager({
      runner: brain,
      emit: {
        created: (task) => server.broadcast('task.created', { task }),
        updated: (task) => server.broadcast('task.updated', { task }),
        progress: (taskId, progress) => server.broadcast('task.progress', { taskId, progress }),
        done: (task) => {
          server.broadcast('task.done', { task });
          this.log?.append('task', `${task.prompt} → ${task.result?.summary ?? 'done'}`);
        },
        error: (taskId, error) => server.broadcast('task.error', { taskId, error }),
        cancelled: (taskId) => server.broadcast('task.cancelled', { taskId }),
      },
      now: daemonEnvelopeContext.now,
      newId: daemonEnvelopeContext.newId,
    });

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
      case 'voice.tool_call':
        return this.handleVoiceToolCall(client, env as WsEnvelope<'voice.tool_call'>);
      case 'config.get':
        return this.handleConfigGet(client, env as WsEnvelope<'config.get'>);
      case 'config.set':
        return this.handleConfigSet(env as WsEnvelope<'config.set'>);
      case 'history.list':
        return this.handleHistoryList(client);
      case 'history.load':
        return this.handleHistoryLoad(client, env as WsEnvelope<'history.load'>);
      case 'history.new':
        return this.handleHistoryNew(client);
      case 'watches.list':
        return this.sendWatches(client);
      case 'watches.add':
        return this.handleWatchAdd(client, env as WsEnvelope<'watches.add'>);
      case 'watches.remove':
        return this.handleWatchRemove(client, env as WsEnvelope<'watches.remove'>);
      default:
        // Not handled in this phase.
        return;
    }
  }

  /**
   * The chat-supervisor tool router. The thin voice model calls these; each replies
   * fast (delegate returns a task_id immediately) so the conversation stays fluid,
   * and progress/results flow asynchronously as task.* broadcasts.
   */
  private handleVoiceToolCall(client: WsClient, env: WsEnvelope<'voice.tool_call'>): void {
    const { name, args } = env.payload;
    const a = (args ?? {}) as Record<string, unknown>;
    const reply = (result: unknown, isError = false) =>
      client.send('voice.tool_result', { result, isError }, { replyTo: env.id });

    switch (name) {
      case 'delegate_to_worker': {
        const prompt = String(a.task ?? a.prompt ?? a.request ?? '').trim();
        if (!prompt) return reply({ error: 'No task text provided.' }, true);
        const taskId = this.tasks.create(prompt);
        return reply({ status: 'started', task_id: taskId });
      }
      case 'check_task_status': {
        const task = this.tasks.check(String(a.task_id ?? ''));
        return reply(
          task
            ? { state: task.state, latest: task.progress.at(-1)?.text ?? 'working on it' }
            : { state: 'unknown', note: 'no such task (it may have finished)' },
        );
      }
      case 'cancel_task': {
        const ok = this.tasks.cancel(String(a.task_id ?? ''));
        return reply({ cancelled: ok });
      }
      default:
        return reply({ error: `Unknown tool: ${name}` }, true);
    }
  }

  private async handleChat(
    client: WsClient,
    env: WsEnvelope<'chat.user_message'>,
  ): Promise<void> {
    const { text, messageId } = env.payload;
    // Per-turn trace: the envelope id correlates every log line for this turn (N8).
    const turnLog = this.logger?.child('turn');
    const startedAt = daemonEnvelopeContext.now();
    turnLog?.info('chat.start', { turnId: env.id, messageId, chars: text.length });
    this.history?.append('user', text);
    try {
      const full = await this.brain.respond(text, (delta) => {
        client.send('chat.assistant_delta', { messageId, delta });
      });
      client.send('chat.assistant_done', { messageId, text: full });
      this.history?.append('assistant', full);
      this.log?.append('chat', `user: ${text} | assistant: ${full.slice(0, 200)}`);
      // Surface token/cost usage when the brain tracks it (N9).
      const usage = (this.brain as { getLastUsage?: () => unknown }).getLastUsage?.();
      turnLog?.info('chat.done', {
        turnId: env.id,
        ms: daemonEnvelopeContext.now() - startedAt,
        chars: full.length,
        ...(usage ? { usage } : {}),
      });
    } catch (err) {
      turnLog?.warn('chat.error', { turnId: env.id, error: String(err) });
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

  private handleHistoryList(client: WsClient): void {
    client.send('history.list_result', { conversations: this.history?.list() ?? [] });
  }

  private handleHistoryLoad(client: WsClient, env: WsEnvelope<'history.load'>): void {
    const { conversationId } = env.payload;
    this.history?.setCurrent(conversationId); // resume: new turns append here
    client.send('history.load_result', {
      conversationId,
      messages: this.history?.load(conversationId) ?? [],
    });
  }

  private handleHistoryNew(client: WsClient): void {
    const conversationId = this.history?.startNew() ?? '';
    client.send('history.new_result', { conversationId });
  }

  /** All watches = built-ins + user-defined. */
  private allWatches(): Watch[] {
    return composeWatches(this.watches?.store);
  }

  private sendWatches(client: WsClient): void {
    client.send('watches.list_result', { watches: this.allWatches() });
  }

  private handleWatchAdd(client: WsClient, env: WsEnvelope<'watches.add'>): void {
    if (this.watches) {
      try {
        this.watches.store.add(env.payload.prompt, env.payload.cron);
        this.watches.reload(this.allWatches());
      } catch (err) {
        client.send('error', { message: String(err), code: 'watch_invalid' });
      }
    }
    this.sendWatches(client);
  }

  private handleWatchRemove(client: WsClient, env: WsEnvelope<'watches.remove'>): void {
    if (this.watches) {
      this.watches.store.remove(env.payload.id);
      this.watches.reload(this.allWatches());
    }
    this.sendWatches(client);
  }
}
