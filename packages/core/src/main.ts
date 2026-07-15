import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { PayloadOf, CapabilityManifest } from '@workerking/shared';
import { WsServer } from './ws/server.js';
import { ConfigStore } from './config/ConfigStore.js';
import { Supervisor } from './supervisor/Supervisor.js';
import { EchoBrain, DeferredBrain, type Brain } from './brain/Brain.js';
import { createClaudeBackend, probeClaude } from './claude/createClaudeBackend.js';
import { createWorkerKingToolServer, WORKERKING_TOOL_ALLOWLIST } from './claude/tools.js';
import { createToolPolicy, summarizeToolCall } from './claude/toolPolicy.js';
import { WsToolConfirmer } from './claude/WsToolConfirmer.js';
import type { ToolPermissionMode } from '@workerking/shared';
import { WsScreenContextProvider } from './screen/ScreenContextProvider.js';
import { CapabilityManager } from './capability/CapabilityManager.js';
import { realCapabilityQueryFn } from './capability/realCapabilityQuery.js';
import { assemblePersonaAppend } from './persona/assemblePersona.js';
import { assemblePersonaFromCard, parseCharacterCard } from './persona/CharacterCard.js';
import { MemoryStore } from './memory/MemoryStore.js';
import { createMemoryIndex } from './memory/MemoryIndex.js';
import { InteractionLog } from './memory/InteractionLog.js';
import { ConversationStore } from './history/ConversationStore.js';
import { TaskStore } from './tasks/TaskStore.js';
import { NightlyJob, createClaudeDistiller } from './memory/NightlyJob.js';
import { ReminderStore } from './proactive/ReminderStore.js';
import { ReminderScheduler } from './proactive/ReminderScheduler.js';
import { ProactiveManager, composeWatches } from './proactive/ProactiveManager.js';
import { WatchStore } from './proactive/WatchStore.js';
import { detectHost } from './util/host.js';
import { daemonEnvelopeContext, newToken } from './util/ids.js';
import { installFileLog } from './util/fileLog.js';
import { createLogger } from './util/logger.js';

const log = createLogger({ scope: 'workerking' });

/** The Voyager-pattern nudge: encourage Claude to grow its own skills. */
const SELF_AUTHOR_NUDGE =
  'If you find yourself doing the same multi-step task more than once, offer to save it as a ' +
  'reusable skill: write a SKILL.md under ~/.claude/skills/<name>/ so it becomes available to you ' +
  '(and voice-routable) next time.';

export const DAEMON_VERSION = '0.0.0';

/**
 * The daemon's stateful, file-backed stores. Injected rather than declared at
 * module scope so a test can point them at a temp dir (or fakes) and merely
 * importing this module has no filesystem side effects — the same
 * dependency-injection style already used by `DaemonSupervisor`/`ClaudeBackend`.
 */
export interface DaemonDeps {
  memory: MemoryStore;
  interactionLog: InteractionLog;
  conversations: ConversationStore;
  watchStore: WatchStore;
  reminderStore: ReminderStore;
  taskStore: TaskStore;
}

/** Build the real file-backed stores, overriding any provided (tests inject). */
export function createDaemonDeps(overrides: Partial<DaemonDeps> = {}): DaemonDeps {
  return {
    memory: overrides.memory ?? new MemoryStore(),
    interactionLog: overrides.interactionLog ?? new InteractionLog(),
    conversations: overrides.conversations ?? new ConversationStore(),
    watchStore: overrides.watchStore ?? new WatchStore(),
    reminderStore: overrides.reminderStore ?? new ReminderStore(),
    taskStore: overrides.taskStore ?? new TaskStore(),
  };
}

export interface StartDaemonOptions {
  port?: number;
  token?: string;
  /** Where to write the handshake file (port + token) for the Electron app. */
  handshakeFile?: string;
  /** Inject a brain (tests). If omitted, boot picks ClaudeBackend or EchoBrain. */
  brain?: Brain;
  /**
   * Force the brain choice. 'auto' (default) probes Claude and falls back to
   * echo; 'claude' requires Claude; 'echo' is the no-AI Phase 0 brain.
   */
  brainMode?: 'auto' | 'claude' | 'echo';
  /** Inject stores (tests point these at a temp dir); real ones built otherwise. */
  deps?: Partial<DaemonDeps>;
}

export interface RunningDaemon {
  port: number;
  token: string;
  server: WsServer;
  stop: () => Promise<void>;
}

/**
 * Resolve the real brain in the background and install it into `deferred`.
 * 'auto' warms/probes Claude Code; if it's authenticated it wins, otherwise we
 * fall back to EchoBrain so the daemon still works (chat UI runs, just without AI,
 * and the user sees a hint to run `claude login`). Never throws — the daemon must
 * not crash on a Claude auth/setup failure.
 */
/**
 * Compute the current persona append from config: a character card if one is
 * imported (Handlebars-assembled), else the simple name+personality form. Read
 * live per message so settings/card changes apply without a restart.
 */
/** Live context sources folded into the assembled system prompt each message. */
export interface PersonaContext {
  memory?: Pick<MemoryStore, 'summary'>;
  /** Current conversation, for the rolling summary of truncated history (N14). */
  conversations?: Pick<ConversationStore, 'currentSummary'>;
  /** The active project directory (claudeCwd), for orientation. */
  cwd?: string;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

/**
 * Ambient context block fed to the model each message: the current time, the
 * active project, and the gist of any earlier conversation that scrolled out of
 * the window. Cheap orientation the model would otherwise spend tool calls (or
 * simply lack) to obtain — and the consumer that finally uses N14's summary.
 */
function buildAmbientContext(ctx: PersonaContext): string {
  const lines: string[] = [];
  const now = (ctx.now ?? (() => new Date()))();
  lines.push(`Current date and time: ${now.toISOString()}.`);
  if (ctx.cwd) lines.push(`Active project: ${basename(ctx.cwd)} (${ctx.cwd}).`);
  const summary = ctx.conversations?.currentSummary();
  if (summary) {
    lines.push(`Earlier in this conversation (summarized, scrolled out of context): ${summary}`);
  }
  return lines.length ? `Ambient context:\n${lines.join('\n')}` : '';
}

export function computePersonaAppend(config: ConfigStore, ctx: PersonaContext = {}): string {
  let base: string;
  const card = config.get('characterCard');
  if (card) {
    try {
      const userName = config.get('userName') as string | undefined;
      base = assemblePersonaFromCard(parseCharacterCard(card), { userName }).systemPrompt.append;
    } catch {
      base = assemblePersonaAppend(config.get());
    }
  } else {
    base = assemblePersonaAppend(config.get());
  }

  // Layer: persona → self-authoring nudge → remembered facts → ambient context.
  const parts = [base, SELF_AUTHOR_NUDGE];
  if (ctx.memory && config.get('memoryEnabled') !== false) {
    const mem = ctx.memory.summary();
    if (mem) parts.push(mem);
  }
  parts.push(buildAmbientContext(ctx));
  return parts.filter(Boolean).join('\n\n');
}

interface Disposable {
  stop: () => void | Promise<void>;
}

async function resolveBrain(
  deferred: DeferredBrain,
  config: ConfigStore,
  server: WsServer,
  mode: 'auto' | 'claude',
  registerDisposable: (d: Disposable) => void,
  deps: DaemonDeps,
  proactiveHolder: { manager?: ProactiveManager } = {},
): Promise<void> {
  const { memory, interactionLog, watchStore, reminderStore, conversations } = deps;
  const cwd = config.get('claudeCwd') as string | undefined;
  /** The active project dir, read live so a Settings change applies per message. */
  const liveCwd = () => config.get('claudeCwd') as string | undefined;

  // Proactive channel: reminders + notify tool → proactive.notify broadcast.
  // If no UI client is connected yet (e.g. a reminder that came due while the
  // daemon was down, before the WS server is even listening), buffer the notice
  // and flush it when the first client connects — so nothing is silently lost.
  const pendingNotices: Array<PayloadOf<'proactive.notify'>> = [];
  const proactiveNotify = (n: {
    text: string;
    level?: 'info' | 'warn' | 'success';
    speak?: boolean;
    source?: string;
  }) => {
    const payload: PayloadOf<'proactive.notify'> = {
      text: n.text,
      level: n.level ?? 'info',
      speak: n.speak ?? true,
      source: n.source,
    };
    if (server.clientCount() === 0) pendingNotices.push(payload);
    else server.broadcast('proactive.notify', payload);
  };
  server.onClientConnected(() => {
    for (const payload of pendingNotices.splice(0)) server.broadcast('proactive.notify', payload);
  });

  const reminderScheduler = new ReminderScheduler({
    store: reminderStore,
    onFire: (r) => proactiveNotify({ text: r.message, source: 'reminder' }),
  });
  reminderScheduler.start();
  registerDisposable({ stop: () => reminderScheduler.stop() });

  const scheduleReminder = (message: string, fireAtMs: number): string => {
    const id = daemonEnvelopeContext.newId();
    const reminder = reminderStore.add(message, fireAtMs, id);
    reminderScheduler.arm(reminder);
    return id;
  };

  // Retrieval backend for recall/list_memories: semantic if enabled + model present,
  // else keyword. Built once (embedding-model init is expensive); reads the store live.
  const memoryIndex = await createMemoryIndex(memory, {
    semantic: config.get('semanticMemory') === true,
  });

  // Screen-awareness + memory + proactive tools (capture runs in Electron main).
  const captureConfirmer = new WsToolConfirmer(server);
  const toolServer = createWorkerKingToolServer({
    config,
    screen: new WsScreenContextProvider(server),
    // N15: route per-capture consent through the same fail-closed UI prompt as N1.
    confirmCapture: (req) =>
      captureConfirmer.confirm({
        tool: 'capture_screen',
        summary: `take a screenshot of your ${req.target}`,
      }),
    memory,
    memoryIndex,
    proactiveNotify,
    scheduleReminder,
    audit: (e) => log.child('tool').info(e.tool, { detail: e.detail }),
  });
  // N1: gate the Claude Code toolset. Destructive tools (Bash/Write/Edit) are
  // confirmed via a fail-closed UI round-trip in 'gated' mode (the default),
  // denied outright in 'readonly', or unchecked in 'auto'. Read live from config.
  const canUseTool = createToolPolicy({
    mode: () => (config.get('toolPermissionMode') as ToolPermissionMode | undefined) ?? 'gated',
    confirmer: new WsToolConfirmer(server),
    summarize: summarizeToolCall,
  });
  // Autonomous background brains (nightly distiller, proactive watches) run with
  // no user present to approve — force them read-only so a scheduled prompt can
  // never run Bash/Write/Edit on its own.
  const backgroundCanUseTool = createToolPolicy({ mode: () => 'readonly' });
  const claudeOpts = {
    cwd,
    // Live working directory: point Claude at the current project without a
    // restart; ClaudeBackend resets the session when it changes (F1).
    cwdProvider: liveCwd,
    // Live persona + ambient context (time, project, conversation summary),
    // re-read on every message.
    personaProvider: () =>
      computePersonaAppend(config, { memory, conversations, cwd: liveCwd() }),
    mcpServers: { workerking: toolServer },
    allowedTools: WORKERKING_TOOL_ALLOWLIST,
    canUseTool,
  };

  const startCapabilities = () => {
    let lastManifest: CapabilityManifest | undefined;
    const cm = new CapabilityManager({
      queryFn: realCapabilityQueryFn,
      sdkOptions: cwd ? { cwd } : {},
      broadcast: (manifest) => {
        lastManifest = manifest;
        server.broadcast('capability.updated', { manifest });
      },
      cwd,
    });
    // Replay the latest manifest to any client that connects after it was built,
    // so the chat command palette always has capabilities to show.
    registerDisposable({
      stop: server.onClientConnected((client) => {
        if (lastManifest) client.send('capability.updated', { manifest: lastManifest });
      }),
    });
    registerDisposable(cm);
    cm.start().catch((e) =>
      log.warn('capability manifest build failed', { error: String(e) }),
    );

    // Nightly memory consolidation (Letta sleep-time), when memory is enabled.
    if (config.get('memoryEnabled') !== false) {
      const distiller = createClaudeDistiller((prompt) =>
        createClaudeBackend({ cwd, canUseTool: backgroundCanUseTool }).respond(prompt, () => {}),
      );
      const job = new NightlyJob({ memory, log: interactionLog, distill: distiller });
      job.start();
      registerDisposable({ stop: () => job.stop() });
    }

    // Proactive/ambient watches (spends Claude quota on a timer) — opt-in.
    if (config.get('proactiveEnabled') === true) {
      const manager = new ProactiveManager({
        respond: (prompt) =>
          createClaudeBackend({ cwd, canUseTool: backgroundCanUseTool }).respond(prompt, () => {}),
        notify: proactiveNotify,
        watches: composeWatches(watchStore),
      });
      manager.start();
      proactiveHolder.manager = manager; // let the supervisor live-reload it
      registerDisposable({ stop: () => manager.stop() });
    }
  };

  if (mode === 'claude') {
    deferred.set(createClaudeBackend(claudeOpts));
    startCapabilities();
    return;
  }

  const health = await probeClaude(cwd);
  if (health.ok) {
    log.info('Claude Code ready — using ClaudeBackend');
    deferred.set(createClaudeBackend(claudeOpts));
    startCapabilities();
  } else {
    log.warn('Claude Code unavailable; falling back to EchoBrain', {
      detail: health.detail ?? 'unknown',
      hint: 'Run `claude login` and restart for the real brain.',
    });
    deferred.set(new EchoBrain());
  }
}

/**
 * Boot the core daemon: WS server + config + supervisor + brain.
 * Returns the bound port and auth token. Callers (Electron main, or a test)
 * decide how to surface those to clients.
 */
export async function startDaemon(opts: StartDaemonOptions = {}): Promise<RunningDaemon> {
  const token = opts.token ?? process.env.WORKERKING_TOKEN ?? newToken();
  const host = detectHost();

  // Headless daemon: persist config so a standalone run doesn't reset on restart.
  const config = new ConfigStore(undefined, { persist: true });
  const server = new WsServer({ token, host, daemonVersion: DAEMON_VERSION });
  // Stores are injected (tests) or built here — never module-global.
  const deps = createDaemonDeps(opts.deps);
  // N12: mark any task left mid-run by a previous crash/restart as interrupted.
  const interrupted = deps.taskStore.reconcileOnBoot();
  if (interrupted.length) log.info('reconciled interrupted tasks', { count: interrupted.length });

  // Pick the brain without blocking boot: an injected brain or the echo brain is
  // used directly; otherwise a DeferredBrain is installed now and the real Claude
  // brain resolves in the background (bounded probe) and swaps itself in.
  const mode = opts.brainMode ?? 'auto';
  const disposables: Disposable[] = [];
  // Tracks the async brain resolution so stop() can wait for late-registered
  // disposables (capability manager / nightly job / proactive) to exist first.
  let brainReady: Promise<void> = Promise.resolve();
  let brain: Brain;
  // Holds the running ProactiveManager (set once the real brain resolves) so the
  // supervisor can live-reload watches when the user adds/removes them.
  const proactiveHolder: { manager?: ProactiveManager } = {};
  if (opts.brain) {
    brain = opts.brain;
  } else if (mode === 'echo') {
    brain = new EchoBrain();
  } else {
    const deferred = new DeferredBrain();
    brain = deferred;
    brainReady = resolveBrain(
      deferred,
      config,
      server,
      mode,
      (d) => disposables.push(d),
      deps,
      proactiveHolder,
    ).catch(() => {});
  }
  new Supervisor(
    server,
    config,
    brain,
    deps.interactionLog,
    deps.conversations,
    {
      store: deps.watchStore,
      reload: (watches) => proactiveHolder.manager?.reload(watches),
    },
    log,
    deps.taskStore,
  );

  const requestedPort =
    opts.port ?? (process.env.WORKERKING_PORT ? Number(process.env.WORKERKING_PORT) : 0);
  const port = await server.start(requestedPort);

  const handshake = { port, token, pid: process.pid, host, daemonVersion: DAEMON_VERSION };
  const handshakeFile = opts.handshakeFile ?? process.env.WORKERKING_HANDSHAKE_FILE;
  if (handshakeFile) {
    writeFileSync(handshakeFile, JSON.stringify(handshake, null, 2), 'utf8');
  }
  // Machine-readable line so a parent process can capture the port without a file.
  process.stdout.write(`WORKERKING_READY ${JSON.stringify(handshake)}\n`);

  return {
    port,
    token,
    server,
    stop: async () => {
      // Wait for the brain probe to finish so late-registered disposables
      // (capability watcher, nightly/proactive crons) are cleaned up, not leaked.
      await brainReady;
      for (const d of disposables) await d.stop();
      await server.close();
    },
  };
}

// Run directly (node src/main.ts / node dist/main.js) — but not when imported by tests.
const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('main.ts') || process.argv[1].endsWith('main.js'));

if (isDirectRun) {
  // Tee stdout/stderr to WORKERKING_LOG_FILE (if set) before anything is printed,
  // so the READY line and startup logs are captured for the log tailer too.
  installFileLog();
  startDaemon()
    .then((d) => {
      log.info('daemon listening', { address: `127.0.0.1:${d.port}` });
      const shutdown = () => {
        d.stop().finally(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      log.error('daemon failed to start', { error: String(err) });
      process.exit(1);
    });
}
