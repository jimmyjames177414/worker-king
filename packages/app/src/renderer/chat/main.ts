import { connectToDaemon, type WsClient } from '../shared/wsClient.js';
import { Settings, type SettingsBridge } from './Settings.js';
import { renderMarkdown } from './markdown.js';
import { decorateAssistantBubble } from './copy.js';

/**
 * Chat renderer entry. Text chat plus a task-list panel (delegated work streamed
 * over task.* events), Markdown-rendered assistant replies, and a transcript that
 * survives app restarts via localStorage.
 */
interface Els {
  log: HTMLElement;
  input: HTMLInputElement;
  form: HTMLFormElement;
  status: HTMLElement;
  tasksList: HTMLElement;
  tasksCount: HTMLElement;
}

function els(): Els {
  return {
    log: document.getElementById('log')!,
    input: document.getElementById('input') as HTMLInputElement,
    form: document.getElementById('composer') as HTMLFormElement,
    status: document.getElementById('status')!,
    tasksList: document.getElementById('tasks-list')!,
    tasksCount: document.getElementById('tasks-count')!,
  };
}

// --- Transcript persistence -------------------------------------------------
const TRANSCRIPT_KEY = 'workerking.transcript.v1';
const MAX_PERSISTED = 200;
type Msg = { who: 'you' | 'wk'; text: string; spoken?: boolean };

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

function renderInto(row: HTMLElement, who: 'you' | 'wk', text: string): void {
  // The user's own text stays literal; assistant replies render Markdown and get
  // copy affordances (message + per-code-block).
  if (who === 'wk') {
    row.innerHTML = renderMarkdown(text);
    decorateAssistantBubble(row, text);
  } else {
    row.textContent = text;
  }
}

function appendBubble(log: HTMLElement, who: 'you' | 'wk'): HTMLElement {
  const row = document.createElement('div');
  row.className = `bubble bubble--${who}`;
  log.appendChild(row);
  log.scrollTop = log.scrollHeight;
  return row;
}

// --- Task list --------------------------------------------------------------
interface TaskView {
  id: string;
  prompt: string;
  state: string;
  latest?: string;
  result?: string;
  error?: string;
}

class TaskList {
  private readonly tasks = new Map<string, TaskView>();
  private readonly rows = new Map<string, HTMLElement>();

  constructor(
    private readonly listEl: HTMLElement,
    private readonly countEl: HTMLElement,
  ) {}

  upsert(view: TaskView): void {
    this.tasks.set(view.id, { ...this.tasks.get(view.id), ...view });
    this.renderRow(view.id);
    this.renderCount();
  }

  progress(id: string, text: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    t.latest = text;
    this.renderRow(id);
  }

  private renderRow(id: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    let row = this.rows.get(id);
    if (!row) {
      row = document.createElement('div');
      row.className = 'task';
      this.listEl.prepend(row);
      this.rows.set(id, row);
    }
    const detail = t.error ?? t.result ?? t.latest ?? '';
    row.className = `task task--${t.state}`;
    row.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'task__head';
    const badge = document.createElement('span');
    badge.className = 'task__badge';
    badge.textContent = t.state;
    const title = document.createElement('span');
    title.className = 'task__title';
    title.textContent = t.prompt;
    head.append(badge, title);
    row.appendChild(head);
    if (detail) {
      const d = document.createElement('div');
      d.className = 'task__detail';
      d.textContent = detail;
      row.appendChild(d);
    }
  }

  private renderCount(): void {
    const active = [...this.tasks.values()].filter(
      (t) => t.state === 'running' || t.state === 'queued' || t.state === 'awaiting_permission',
    ).length;
    this.countEl.textContent = active ? String(active) : '';
    this.countEl.classList.toggle('has', active > 0);
  }
}

async function main(): Promise<void> {
  const { log, input, form, status, tasksList, tasksCount } = els();
  const transcript = loadTranscript();
  const taskList = new TaskList(tasksList, tasksCount);

  // Restore prior transcript so history survives an app restart.
  for (const m of transcript) addMessage(m.who, m.text, m.spoken);
  log.scrollTop = log.scrollHeight;

  function addMessage(who: 'you' | 'wk', text: string, spoken = false): HTMLElement {
    const row = appendBubble(log, who);
    if (spoken) row.classList.add('bubble--spoken');
    renderInto(row, who, text);
    return row;
  }

  const record = (who: 'you' | 'wk', text: string, spoken = false) => {
    transcript.push({ who, text, spoken });
    saveTranscript(transcript);
  };

  const clearConversation = () => {
    log.innerHTML = '';
    transcript.length = 0;
    saveTranscript(transcript);
  };

  let client: WsClient;
  try {
    client = await connectToDaemon();
  } catch (err) {
    status.textContent = `disconnected: ${String(err)}`;
    return;
  }

  client.on('welcome', (env) => {
    status.textContent = `connected (daemon ${env.payload.daemonVersion}, host ${env.payload.host})`;
  });

  // Settings panel and panel toggles.
  const bridge = (
    window as unknown as {
      workerking: SettingsBridge & { onReconnect(cb: () => void): void };
    }
  ).workerking;
  bridge.onReconnect(() => client.reconnect());
  wirePanels();

  // Track the in-flight assistant bubble by messageId.
  const bubbles = new Map<string, HTMLElement>();

  client.on('chat.assistant_delta', (env) => {
    const id = env.payload.messageId ?? '_';
    let entry = bubbles.get(id);
    if (!entry) {
      entry = appendBubble(log, 'wk');
      entry.dataset['raw'] = '';
      bubbles.set(id, entry);
    }
    entry.dataset['raw'] = (entry.dataset['raw'] ?? '') + env.payload.delta;
    entry.textContent = entry.dataset['raw'] ?? ''; // plain while streaming
    log.scrollTop = log.scrollHeight;
  });

  client.on('chat.assistant_done', (env) => {
    const id = env.payload.messageId ?? '_';
    const entry = bubbles.get(id);
    const text = env.payload.text;
    if (entry) {
      renderInto(entry, 'wk', text); // Markdown once complete
      bubbles.delete(id);
    }
    record('wk', text);
  });

  // Task events → the task-list panel.
  client.on('task.created', (env) => {
    const t = env.payload.task;
    taskList.upsert({ id: t.id, prompt: t.prompt, state: t.state });
  });
  client.on('task.progress', (env) => {
    taskList.progress(env.payload.taskId, env.payload.progress.text);
  });
  client.on('task.done', (env) => {
    const t = env.payload.task;
    taskList.upsert({ id: t.id, prompt: t.prompt, state: t.state, result: t.result?.summary });
  });
  client.on('task.error', (env) => {
    taskList.upsert({ id: env.payload.taskId, prompt: '', state: 'error', error: env.payload.error });
  });
  client.on('task.cancelled', (env) => {
    taskList.upsert({ id: env.payload.taskId, prompt: '', state: 'cancelled' });
  });

  // Spoken turns from the voice layer appear in the chat log too (final only, to
  // avoid partial-transcript churn), marked as spoken and persisted like typed ones.
  client.on('voice.transcript', (env) => {
    if (!env.payload.final) return;
    const who = env.payload.role === 'user' ? 'you' : 'wk';
    addMessage(who, env.payload.text, true);
    record(who, env.payload.text, true);
    log.scrollTop = log.scrollHeight;
  });

  document.getElementById('clear')?.addEventListener('click', clearConversation);

  client.on('error', (env) => {
    status.textContent = `error: ${env.payload.message}`;
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const messageId = crypto.randomUUID();
    renderInto(appendBubble(log, 'you'), 'you', text);
    record('you', text);
    client.send('chat.user_message', { text, messageId });
    input.value = '';
  });
}

/** Wire the settings (⚙) and tasks (📋) slide-over panels. */
function wirePanels(): void {
  const bridge = (window as unknown as { workerking: SettingsBridge }).workerking;
  const settingsEl = document.getElementById('settings');
  const settingsBody = document.getElementById('settings-body');
  if (settingsEl && settingsBody) {
    const settings = new Settings(settingsBody, bridge);
    document.getElementById('gear')?.addEventListener('click', () => {
      settingsEl.classList.add('open');
      void settings.render();
    });
    document
      .getElementById('settings-close')
      ?.addEventListener('click', () => settingsEl.classList.remove('open'));
  }

  const tasksEl = document.getElementById('tasks-panel');
  document.getElementById('tasks-toggle')?.addEventListener('click', () => tasksEl?.classList.toggle('open'));
  document.getElementById('tasks-close')?.addEventListener('click', () => tasksEl?.classList.remove('open'));
}

main();
