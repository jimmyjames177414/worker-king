import './tokens.css';
import './app.css';

import { connectToDaemon, type WsClient } from '../shared/wsClient.js';
import { Settings, type SettingsBridge } from './Settings.js';
import { applyTheme, normalizeThemePref } from '../shared/theme.js';
import { CommandPalette } from './palette.js';
import { ActivityFeed } from './ActivityFeed.js';
import { Shell, type ViewId } from './Shell.js';
import { TitleBar, type WindowControls } from './TitleBar.js';
import { MessageView, type Who } from './MessageView.js';
import { HistoryView } from './views/HistoryView.js';
import { WatchesView } from './views/WatchesView.js';
import { TasksView } from './views/TasksView.js';
import { dayStamp, sameDay } from './relTime.js';
import type { CapabilityManifestEntry, PayloadOf } from '@workerking/shared';

/**
 * Chat renderer entry.
 *
 * The window is a desktop shell: a custom title bar, a command rail, and six
 * views the rail switches between. This file owns the wiring — WS handlers, the
 * transcript (persisted to localStorage), and the router callbacks — while the
 * views themselves live in ./views and ./Shell.
 */

/** Everything the chat preload bridge exposes. */
type ChatBridge = SettingsBridge &
  WindowControls & {
    onReconnect(cb: () => void): void;
    showWindow?(): void;
  };

// --- Transcript persistence -------------------------------------------------
const TRANSCRIPT_KEY = 'workerking.transcript.v1';
const MAX_PERSISTED = 200;
type Msg = { who: Who; text: string; spoken?: boolean; ts?: number };

function loadTranscript(): Msg[] {
  try {
    const raw = localStorage.getItem(TRANSCRIPT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveTranscript(msgs: Msg[]): void {
  try {
    localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(msgs.slice(-MAX_PERSISTED)));
  } catch {
    // Quota/serialization failures must never break the chat.
  }
}

/** An assistant turn still streaming in, keyed by messageId. */
interface Turn {
  view: MessageView;
  raw: string;
  lastUpdate: number;
  startedAt: number;
}

async function main(): Promise<void> {
  const bridge = (window as unknown as { workerking: ChatBridge }).workerking;
  const shell = new Shell();
  new TitleBar(bridge);

  const log = document.getElementById('log')!;
  const scroller = document.getElementById('chat-scroll')!;
  const input = document.getElementById('input') as HTMLInputElement;
  const form = document.getElementById('composer') as HTMLFormElement;
  const scrollToEnd = () => {
    scroller.scrollTop = scroller.scrollHeight;
  };

  const transcript = loadTranscript();
  let lastUserText = '';
  /** Day of the last rendered message, so separators only appear on a change. */
  let lastDayTs: number | undefined;

  const retryLast = () => {
    if (lastUserText) submit(lastUserText);
  };

  function addDaySeparator(ts?: number): void {
    if (ts === undefined) return; // legacy transcript entries carry no timestamp
    if (lastDayTs !== undefined && sameDay(lastDayTs, ts)) return;
    const sep = document.createElement('div');
    sep.className = 'msg-day';
    sep.textContent = dayStamp(ts);
    log.appendChild(sep);
    lastDayTs = ts;
  }

  /** Append an empty row and return its view (assistant rows get Retry). */
  function newRow(who: Who, opts: { spoken?: boolean; ts?: number } = {}): MessageView {
    addDaySeparator(opts.ts);
    const view = new MessageView(who, {
      ...(opts.spoken !== undefined ? { spoken: opts.spoken } : {}),
      ...(who === 'wk' ? { onRetry: retryLast } : {}),
    });
    log.appendChild(view.root);
    scrollToEnd();
    return view;
  }

  function addMessage(who: Who, text: string, opts: { spoken?: boolean; ts?: number } = {}): void {
    newRow(who, opts).render(text);
  }

  const record = (who: Who, text: string, spoken = false) => {
    transcript.push({ who, text, spoken, ts: Date.now() });
    saveTranscript(transcript);
  };

  const clearConversation = () => {
    log.replaceChildren();
    transcript.length = 0;
    lastDayTs = undefined;
    saveTranscript(transcript);
  };

  // Restore prior transcript so history survives an app restart.
  for (const m of transcript) {
    addMessage(m.who, m.text, {
      ...(m.spoken !== undefined ? { spoken: m.spoken } : {}),
      ...(m.ts !== undefined ? { ts: m.ts } : {}),
    });
  }
  scrollToEnd();

  // --- Views ---------------------------------------------------------------
  const tasksView = new TasksView(
    document.getElementById('tasks-list')!,
    document.getElementById('tasks-count'),
    { onActiveCountChange: (n) => shell.setBadge('tasks', n) },
  );

  // Activity auto-switch: jump to the feed when CLI work starts and jump back
  // when everything settles — but only while the user hasn't taken navigation
  // over themselves (any manual click releases the auto-drive, see onNavigate).
  let autoOpenEnabled = true;
  let autoReturnTo: ViewId | null = null;
  const activityFeed = new ActivityFeed(
    document.getElementById('activity-list')!,
    document.getElementById('activity-count')!,
    (busy) => {
      shell.setLive('activity', busy);
      if (busy) {
        if (autoOpenEnabled && shell.view !== 'activity') {
          autoReturnTo = shell.view;
          shell.setView('activity', 'auto');
        }
      } else if (autoReturnTo) {
        shell.setView(autoReturnTo, 'auto');
        autoReturnTo = null;
      }
    },
  );

  let client: WsClient;
  try {
    client = await connectToDaemon();
  } catch (err) {
    shell.setConnected(false, 'Disconnected');
    shell.setNotice(String(err));
    return;
  }

  // Settings talks to main over IPC for config/secrets, but feature availability
  // is the daemon's answer — so that one question rides the WS bus.
  const settings = new Settings(
    document.getElementById('settings-body')!,
    {
      getConfig: () => bridge.getConfig(),
      setConfig: (key, value) => bridge.setConfig(key, value),
      setSecret: (key, value) => bridge.setSecret(key, value),
      hasSecret: (key) => bridge.hasSecret(key),
      getFeatures: async () => {
        const env = await client.request('runtime.features', {}, 5000);
        return (env.payload as PayloadOf<'runtime.features_result'>).features;
      },
    },
    clearConversation,
  );

  const historyView = new HistoryView(
    document.querySelector<HTMLElement>('[data-view="history"]')!,
    {
      onOpen: (conversationId) => client.send('history.load', { conversationId }),
      onNew: () => {
        client.send('history.new', {});
        clearConversation();
        shell.setView('chat');
      },
    },
  );

  const watchesView = new WatchesView(
    document.querySelector<HTMLElement>('[data-view="watches"]')!,
    {
      onAdd: (prompt, cron) => client.send('watches.add', { prompt, cron }),
      onRemove: (id) => client.send('watches.remove', { id }),
      onCountChange: (n) => shell.setBadge('watches', n),
    },
  );

  // Entering a view is what fetches its data; a manual click also hands
  // navigation back to the user (the activity auto-switch stops driving it).
  shell.onNavigate((id, source) => {
    if (source === 'user') autoReturnTo = null;
    if (id === 'history') client.send('history.list', {});
    if (id === 'watches') client.send('watches.list', {});
    if (id === 'settings') void settings.render();
  });

  shell.onReconnect(() => client.reconnect());
  bridge.onReconnect(() => client.reconnect());

  client.on('welcome', (env) => {
    shell.setConnected(true);
    shell.setNotice('');
    shell.setDaemonInfo(env.payload.daemonVersion, env.payload.host);
  });

  // N1: destructive-tool confirmation. The daemon asks before running a gated
  // tool (Bash/Write/Edit); we surface a blocking prompt and reply. Fail-closed:
  // anything other than an explicit OK denies.
  client.on('tool.confirm_request', (env) => {
    const { tool, summary } = env.payload;
    // Voice-first usage: this window may never have been opened. Surface it
    // first — a confirm dialog in a hidden window silently times out to deny.
    bridge.showWindow?.();
    const approved = window.confirm(
      `WorkerKing wants to ${summary}\n\n[${tool}] Allow this action?`,
    );
    client.send('tool.confirm_response', { approved }, { replyTo: env.id });
  });

  // Theme: apply the persisted preference now, and live-update when it changes.
  void bridge.getConfig().then((cfg) => {
    applyTheme(normalizeThemePref(cfg['theme']));
    autoOpenEnabled = cfg['activityAutoOpen'] !== false; // default on
  });
  client.on('config.changed', (env) => {
    if (env.payload.key === 'theme') applyTheme(normalizeThemePref(env.payload.value));
    if (env.payload.key === 'activityAutoOpen') autoOpenEnabled = env.payload.value !== false;
  });

  // Command palette: cache the capability manifest, filter it on "/".
  let capabilities: CapabilityManifestEntry[] = [];
  client.on('capability.updated', (env) => {
    capabilities = env.payload.manifest.entries;
  });
  const palette = new CommandPalette(input, form, () => capabilities);
  const ask = document.getElementById('ask');
  ask?.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus on the input
  ask?.addEventListener('click', () => palette.open());

  // --- In-flight assistant turns ------------------------------------------
  // Tracked by messageId, with a last-update stamp so a stalled stream (daemon
  // died mid-turn, chat.assistant_done never arrives) is swept instead of
  // leaking the map entry + row forever.
  const turns = new Map<string, Turn>();
  /** Submit time per messageId, so a completed turn can report its duration. */
  const startedAt = new Map<string, number>();
  const STALE_TURN_MS = 60_000;

  function ensureTurn(id: string): Turn {
    let turn = turns.get(id);
    if (!turn) {
      turn = {
        view: newRow('wk', { ts: Date.now() }),
        raw: '',
        lastUpdate: Date.now(),
        startedAt: startedAt.get(id) ?? Date.now(),
      };
      turns.set(id, turn);
    }
    return turn;
  }

  const staleTurnSweep = setInterval(() => {
    const now = Date.now();
    for (const [id, turn] of turns) {
      if (now - turn.lastUpdate < STALE_TURN_MS) continue;
      turn.view.render(`${turn.raw}\n\n_(connection lost)_`);
      turns.delete(id);
      startedAt.delete(id);
    }
  }, 15_000);
  window.addEventListener('beforeunload', () => clearInterval(staleTurnSweep));

  // A real socket drop (not step-silence) is what settles live activity groups:
  // a slow single tool call keeps the socket open, so it stays "working".
  client.onStatusChange((connected) => {
    shell.setConnected(connected);
    if (!connected) activityFeed.finalizeAllActive('disconnected');
  });

  client.on('chat.assistant_delta', (env) => {
    const turn = ensureTurn(env.payload.messageId ?? '_');
    turn.raw += env.payload.delta;
    turn.view.setStreaming(turn.raw);
    turn.lastUpdate = Date.now();
    scrollToEnd();
  });

  client.on('chat.assistant_done', (env) => {
    const id = env.payload.messageId ?? '_';
    const text = env.payload.text;
    const turn = ensureTurn(id); // covers replies that never streamed a delta
    turn.view.setElapsed(Date.now() - turn.startedAt);
    turn.view.render(text); // Markdown once complete
    turns.delete(id);
    startedAt.delete(id);
    activityFeed.finalize(id, 'done');
    record('wk', text);
    scrollToEnd();
  });

  // Live execution feed → the activity view, plus inline chips on the chat turn
  // the steps belong to (correlated by messageId).
  client.on('activity.step', (env) => {
    activityFeed.apply(env.payload);
    const messageId = env.payload.messageId;
    if (!messageId) return;
    const step = env.payload.step;
    if (step.kind === 'tool_use') {
      ensureTurn(messageId).view.addTool(step.toolId, step.label, step.summary);
      scrollToEnd();
    } else if (step.kind === 'tool_result') {
      turns.get(messageId)?.view.resolveTool(step.toolId, step.ok);
    }
  });

  // Task events → the tasks view (+ activity-group titles/finalization).
  client.on('task.created', (env) => {
    const t = env.payload.task;
    tasksView.upsert({ id: t.id, prompt: t.prompt, state: t.state });
    activityFeed.setTitle(t.id, t.prompt);
  });
  client.on('task.updated', (env) => {
    const t = env.payload.task;
    tasksView.upsert({ id: t.id, prompt: t.prompt, state: t.state });
    activityFeed.setTitle(t.id, t.prompt);
  });
  client.on('task.progress', (env) => {
    tasksView.progress(env.payload.taskId, env.payload.progress.text);
  });
  client.on('task.done', (env) => {
    const t = env.payload.task;
    tasksView.upsert({
      id: t.id,
      prompt: t.prompt,
      state: t.state,
      ...(t.result?.summary !== undefined ? { result: t.result.summary } : {}),
    });
    activityFeed.finalize(t.id, t.state);
  });
  client.on('task.error', (env) => {
    tasksView.upsert({
      id: env.payload.taskId,
      prompt: '',
      state: 'error',
      error: env.payload.error,
    });
    activityFeed.finalize(env.payload.taskId, 'error');
  });
  client.on('task.cancelled', (env) => {
    tasksView.upsert({ id: env.payload.taskId, prompt: '', state: 'cancelled' });
    activityFeed.finalize(env.payload.taskId, 'cancelled');
  });

  // Spoken turns from the voice layer appear in the chat log too (final only, to
  // avoid partial-transcript churn), marked as spoken and persisted like typed ones.
  client.on('voice.transcript', (env) => {
    if (!env.payload.final) return;
    const who: Who = env.payload.role === 'user' ? 'you' : 'wk';
    addMessage(who, env.payload.text, { spoken: true, ts: Date.now() });
    record(who, env.payload.text, true);
    scrollToEnd();
  });

  client.on('history.list_result', (env) => {
    historyView.setConversations(env.payload.conversations);
  });

  client.on('history.load_result', (env) => {
    // Replace the log + local transcript with the loaded conversation.
    log.replaceChildren();
    transcript.length = 0;
    lastDayTs = undefined;
    for (const m of env.payload.messages) {
      const who: Who = m.role === 'user' ? 'you' : 'wk';
      addMessage(who, m.text, { ts: m.ts });
      transcript.push({ who, text: m.text, ts: m.ts });
    }
    saveTranscript(transcript);
    shell.setView('chat');
    scrollToEnd();
  });

  client.on('watches.list_result', (env) => {
    watchesView.setWatches(env.payload.watches);
  });

  client.on('error', (env) => {
    shell.setNotice(env.payload.message);
  });

  function submit(text: string): void {
    const messageId = crypto.randomUUID();
    const ts = Date.now();
    lastUserText = text;
    startedAt.set(messageId, ts);
    addMessage('you', text, { ts });
    record('you', text);
    client.send('chat.user_message', { text, messageId });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    submit(text);
  });
}

main();
