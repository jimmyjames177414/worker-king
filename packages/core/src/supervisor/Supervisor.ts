import type { WsServer, WsClient } from '../ws/server.js';
import type { ActivityStep, WsEnvelope } from '@workerking/shared';
import {
  activityLabel,
  previewToolResult,
  summarizeToolInput,
  truncateThinking,
} from '@workerking/shared';
import { ClaudeAuthError, ClaudeRateLimitError } from '../claude/ClaudeBackend.js';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { Brain } from '../brain/Brain.js';
import { TaskManager } from '../tasks/TaskManager.js';
import type { TaskStore } from '../tasks/TaskStore.js';
import { daemonEnvelopeContext } from '../util/ids.js';
import type { InteractionLog } from '../memory/InteractionLog.js';
import type { ConversationStore } from '../history/ConversationStore.js';
import type { WatchStore } from '../proactive/WatchStore.js';
import { composeWatches } from '../proactive/ProactiveManager.js';
import type { Watch } from '@workerking/shared';
import type { Logger } from '../util/logger.js';
import type { EnvironmentContext } from '../environment/EnvironmentContext.js';

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
  /** Chat turns run one at a time; see handleChat(). */
  private chatChain: Promise<void> = Promise.resolve();
  /** Chat turns currently streaming (feeds the avatar "working" state). */
  private chatBusy = 0;
  /** Tasks currently executing (feeds the avatar "working" state). */
  private readonly runningTaskIds = new Set<string>();
  /** Last avatar.state we broadcast, so refreshAvatar() only emits on a change. */
  private lastAvatar: 'idle' | 'thinking' = 'idle';

  constructor(
    private readonly server: WsServer,
    private readonly config: ConfigStore,
    private readonly brain: Brain,
    private readonly log?: InteractionLog,
    private readonly history?: ConversationStore,
    private readonly watches?: WatchDeps,
    /** Structured logger for per-turn tracing (N8). */
    private readonly logger?: Logger,
    /** Durable task record (N12); survives restarts and outlives eviction. */
    taskStore?: TaskStore,
    /** Repo-root resolver backing delegate_to_worker's `folder` argument. */
    private readonly environment?: Pick<EnvironmentContext, 'resolveRepoPath'>,
  ) {
    // TaskManager drives delegated (voice) work; its events become task.* broadcasts.
    this.tasks = new TaskManager({
      runner: brain,
      emit: {
        created: (task) => {
          server.broadcast('task.created', { task });
          this.trackTask(task.id, task.state === 'running');
        },
        updated: (task) => {
          server.broadcast('task.updated', { task });
          this.trackTask(task.id, task.state === 'running');
        },
        progress: (taskId, progress) => server.broadcast('task.progress', { taskId, progress }),
        activity: (_taskId, step) => this.broadcastActivity(step),
        done: (task) => {
          server.broadcast('task.done', { task });
          this.trackTask(task.id, false);
          this.log?.append('task', `${task.prompt} → ${task.result?.summary ?? 'done'}`);
        },
        error: (taskId, error) => {
          server.broadcast('task.error', { taskId, error });
          this.trackTask(taskId, false);
        },
        cancelled: (taskId) => {
          server.broadcast('task.cancelled', { taskId });
          this.trackTask(taskId, false);
        },
      },
      now: daemonEnvelopeContext.now,
      newId: daemonEnvelopeContext.newId,
      store: taskStore,
    });

    this.server.onMessage((client, env) => {
      // Route by kind; unknown kinds are ignored (forward-compatible). A handler
      // throw must never become an unhandled rejection (which would kill the
      // daemon on Node ≥ 15) — surface it to the sender instead.
      this.dispatch(client, env).catch((err) => {
        this.logger?.warn('dispatch failed', { kind: env.kind, error: String(err) });
        client.send('error', { message: String(err), code: 'internal_error' });
      });
    });

    // Rebroadcast config changes to every client (renderers keep settings live).
    this.config.onChange((key, value) => {
      this.server.broadcast('config.changed', { key, value });
    });
  }

  /** Track a task as running (or not) and refresh the avatar's working state. */
  private trackTask(taskId: string, running: boolean): void {
    if (running) this.runningTaskIds.add(taskId);
    else this.runningTaskIds.delete(taskId);
    this.refreshAvatar();
  }

  /**
   * Drive the floating avatar from whether the agent is doing anything (a chat
   * turn streaming OR a task running). Idempotent: broadcasts only on a change,
   * so a busy stretch doesn't spam the bus. The overlay lets a live voice
   * session take precedence over this (voice owns the avatar while it's active).
   */
  private refreshAvatar(): void {
    const want: 'idle' | 'thinking' =
      this.chatBusy > 0 || this.runningTaskIds.size > 0 ? 'thinking' : 'idle';
    if (want === this.lastAvatar) return;
    this.lastAvatar = want;
    this.server.broadcast('avatar.state', { state: want });
  }

  /** Broadcast one activity step, honoring the master + thinking config gates. */
  private broadcastActivity(step: ActivityStep): void {
    if (this.config.get('activityStreamEnabled') === false) return;
    if (step.step.kind === 'thinking' && this.config.get('activityShowThinking') === false) return;
    this.server.broadcast('activity.step', step);
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
      case 'proactive.notify':
        // External clients (e.g. Sprint) can push a proactive notice by sending
        // this message; the daemon re-broadcasts it so the overlay speaks it.
        this.server.broadcast('proactive.notify', (env as WsEnvelope<'proactive.notify'>).payload);
        return;
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
  private async handleVoiceToolCall(
    client: WsClient,
    env: WsEnvelope<'voice.tool_call'>,
  ): Promise<void> {
    const { name, args } = env.payload;
    const a = (args ?? {}) as Record<string, unknown>;
    const reply = (result: unknown, isError = false) =>
      client.send('voice.tool_result', { result, isError }, { replyTo: env.id });

    switch (name) {
      case 'delegate_to_worker': {
        const prompt = String(a.task ?? a.prompt ?? a.request ?? '').trim();
        if (!prompt) return reply({ error: 'No task text provided.' }, true);
        // Optional folder targeting: resolve a repo name/path against the known
        // roots so the task runs there instead of the chat's active project.
        let cwd: string | undefined;
        const folder = String(a.folder ?? '').trim();
        if (folder && this.environment) {
          const resolved = await this.environment.resolveRepoPath(folder);
          if (!resolved.ok) return reply({ error: resolved.error }, true);
          cwd = resolved.path;
        }
        const taskId = this.tasks.create(prompt, { cwd });
        return reply({ status: 'started', task_id: taskId, ...(cwd ? { folder: cwd } : {}) });
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

  private handleChat(client: WsClient, env: WsEnvelope<'chat.user_message'>): Promise<void> {
    // Serialize chat turns: two rapid user messages must not both call
    // brain.respond() concurrently — the SDK session's `resume` id is only set
    // after the first call resolves, so overlapping calls fork the thread and
    // last-writer-wins on sessionId. Streaming still happens per-turn; this just
    // gates when a turn is allowed to START. A rejected turn must not wedge the
    // chain for every turn after it, so the chain itself always resolves —
    // the caller still gets the turn's own outcome via `turn`.
    const turn = this.chatChain.then(() => this.runChatTurn(client, env));
    this.chatChain = turn.catch(() => {});
    return turn;
  }

  private async runChatTurn(client: WsClient, env: WsEnvelope<'chat.user_message'>): Promise<void> {
    const { text, messageId } = env.payload;
    // Per-turn trace: the envelope id correlates every log line for this turn (N8).
    const turnLog = this.logger?.child('turn');
    const startedAt = daemonEnvelopeContext.now();
    // brainId distinguishes a real Claude reply from an EchoBrain fallback (or a
    // still-resolving DeferredBrain) — without it, a wrong/echoed answer in the
    // transcript is indistinguishable from a real Claude reply in the logs.
    turnLog?.info('chat.start', {
      turnId: env.id,
      messageId,
      chars: text.length,
      brainId: this.brain.id,
    });
    // Remember which conversation this turn belongs to: if the user starts/loads
    // another conversation while the reply streams, the assistant turn must
    // still land here, not in whichever conversation is current at completion.
    const conversationId = this.history?.append('user', text);
    // Live execution feed for this turn: sent to the requesting client only
    // (like the delta stream), correlated by messageId. Gated by config.
    const streamActivity = this.config.get('activityStreamEnabled') !== false;
    const showThinking = this.config.get('activityShowThinking') !== false;
    let seq = 0;
    const sendStep = (step: ActivityStep['step']) => {
      client.send('activity.step', { ts: daemonEnvelopeContext.now(), seq: seq++, messageId, step });
    };
    const activity = streamActivity
      ? {
          onToolInput: ({ id, name, input }: { id: string; name: string; input: unknown }) =>
            sendStep({
              kind: 'tool_use',
              toolId: id,
              tool: name,
              label: activityLabel(name),
              summary: summarizeToolInput(name, input),
            }),
          onToolResult: ({
            toolId,
            isError,
            content,
          }: {
            toolId: string;
            isError: boolean;
            content: unknown;
          }) => {
            const { ok, preview } = previewToolResult(content, isError);
            sendStep({ kind: 'tool_result', toolId, ok, preview });
          },
          ...(showThinking
            ? { onThinking: (t: string) => sendStep({ kind: 'thinking', text: truncateThinking(t) }) }
            : {}),
        }
      : undefined;

    this.chatBusy++;
    this.refreshAvatar();
    try {
      const full = await this.brain.respond(
        text,
        (delta) => {
          client.send('chat.assistant_delta', { messageId, delta });
        },
        activity,
      );
      client.send('chat.assistant_done', { messageId, text: full });
      if (conversationId) this.history?.appendTo(conversationId, 'assistant', full);
      this.log?.append('chat', `user: ${text} | assistant: ${full.slice(0, 200)}`);
      // Surface token/cost usage when the brain tracks it (N9).
      const usage = this.brain.getLastUsage?.();
      turnLog?.info('chat.done', {
        turnId: env.id,
        ms: daemonEnvelopeContext.now() - startedAt,
        chars: full.length,
        brainId: this.brain.id,
        ...(usage ? { usage } : {}),
      });
    } catch (err) {
      turnLog?.warn('chat.error', {
        turnId: env.id,
        brainId: this.brain.id,
        error: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      // Keep the classified conditions distinct so the UI can react (retry hint
      // for a limit, login hint for auth) instead of a generic failure.
      const code =
        err instanceof ClaudeRateLimitError
          ? 'rate_limited'
          : err instanceof ClaudeAuthError
            ? 'auth_required'
            : 'brain_error';
      client.send('error', {
        message: `Brain failed: ${String(err)}`,
        code,
      });
    } finally {
      this.chatBusy--;
      this.refreshAvatar();
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
    // Drop the live model session too — otherwise the UI shows the loaded
    // transcript while the model keeps answering from the previous thread.
    this.logger?.info('brain.session_reset', { reason: 'history.load', conversationId });
    this.brain.resetSession?.();
    client.send('history.load_result', {
      conversationId,
      messages: this.history?.load(conversationId) ?? [],
    });
  }

  private handleHistoryNew(client: WsClient): void {
    const conversationId = this.history?.startNew() ?? '';
    // "New chat" must reset the model's context, not just the transcript —
    // without this the next message resumes the old session (context bleed).
    this.logger?.info('brain.session_reset', { reason: 'history.new', conversationId });
    this.brain.resetSession?.();
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
      try {
        this.watches.store.remove(env.payload.id);
        this.watches.reload(this.allWatches());
      } catch (err) {
        client.send('error', { message: String(err), code: 'watch_invalid' });
      }
    }
    this.sendWatches(client);
  }
}
