import { writeFileSync } from 'node:fs';
import { WsServer } from './ws/server.js';
import { ConfigStore } from './config/ConfigStore.js';
import { Supervisor } from './supervisor/Supervisor.js';
import { EchoBrain, DeferredBrain, type Brain } from './brain/Brain.js';
import { createClaudeBackend, probeClaude } from './claude/createClaudeBackend.js';
import { createWorkerKingToolServer, WORKERKING_TOOL_ALLOWLIST } from './claude/tools.js';
import { WsScreenContextProvider } from './screen/ScreenContextProvider.js';
import { CapabilityManager } from './capability/CapabilityManager.js';
import { realCapabilityQueryFn } from './capability/realCapabilityQuery.js';
import { assemblePersonaAppend } from './persona/assemblePersona.js';
import { assemblePersonaFromCard, parseCharacterCard } from './persona/CharacterCard.js';
import { detectHost } from './util/host.js';
import { newToken } from './util/ids.js';

export const DAEMON_VERSION = '0.0.0';

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
export function computePersonaAppend(config: ConfigStore): string {
  const card = config.get('characterCard');
  if (card) {
    try {
      const userName = config.get('userName') as string | undefined;
      return assemblePersonaFromCard(parseCharacterCard(card), { userName }).systemPrompt.append;
    } catch {
      // Malformed card → fall back to the simple persona.
    }
  }
  return assemblePersonaAppend(config.get());
}

async function resolveBrain(
  deferred: DeferredBrain,
  config: ConfigStore,
  server: WsServer,
  mode: 'auto' | 'claude',
  onCapabilityManager: (cm: CapabilityManager) => void,
): Promise<void> {
  const cwd = config.get('claudeCwd') as string | undefined;

  // Screen-awareness tools: capture runs in Electron main (reached over WS).
  const toolServer = createWorkerKingToolServer({
    config,
    screen: new WsScreenContextProvider(server),
    audit: (e) => process.stderr.write(`[workerking][screen] ${e.tool}: ${e.detail}\n`),
  });
  const claudeOpts = {
    cwd,
    // Live persona: re-read config (incl. character card) on every message.
    personaProvider: () => computePersonaAppend(config),
    mcpServers: { workerking: toolServer },
    allowedTools: WORKERKING_TOOL_ALLOWLIST,
  };

  const startCapabilities = () => {
    const cm = new CapabilityManager({
      queryFn: realCapabilityQueryFn,
      sdkOptions: cwd ? { cwd } : {},
      broadcast: (manifest) => server.broadcast('capability.updated', { manifest }),
      cwd,
    });
    onCapabilityManager(cm);
    cm.start().catch((e) =>
      process.stderr.write(`[workerking] capability manifest build failed: ${String(e)}\n`),
    );
  };

  if (mode === 'claude') {
    deferred.set(createClaudeBackend(claudeOpts));
    startCapabilities();
    return;
  }

  const health = await probeClaude(cwd);
  if (health.ok) {
    process.stderr.write('[workerking] Claude Code ready — using ClaudeBackend\n');
    deferred.set(createClaudeBackend(claudeOpts));
    startCapabilities();
  } else {
    process.stderr.write(
      `[workerking] Claude Code unavailable (${health.detail ?? 'unknown'}); ` +
        'falling back to EchoBrain. Run `claude login` and restart for the real brain.\n',
    );
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

  const config = new ConfigStore();
  const server = new WsServer({ token, host, daemonVersion: DAEMON_VERSION });

  // Pick the brain without blocking boot: an injected brain or the echo brain is
  // used directly; otherwise a DeferredBrain is installed now and the real Claude
  // brain resolves in the background (bounded probe) and swaps itself in.
  const mode = opts.brainMode ?? 'auto';
  let capabilityManager: CapabilityManager | undefined;
  let brain: Brain;
  if (opts.brain) {
    brain = opts.brain;
  } else if (mode === 'echo') {
    brain = new EchoBrain();
  } else {
    const deferred = new DeferredBrain();
    brain = deferred;
    void resolveBrain(deferred, config, server, mode, (cm) => {
      capabilityManager = cm;
    });
  }
  new Supervisor(server, config, brain);

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
      await capabilityManager?.stop();
      await server.close();
    },
  };
}

// Run directly (node src/main.ts / node dist/main.js) — but not when imported by tests.
const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('main.ts') || process.argv[1].endsWith('main.js'));

if (isDirectRun) {
  startDaemon()
    .then((d) => {
      process.stderr.write(`[workerking] daemon listening on 127.0.0.1:${d.port}\n`);
      const shutdown = () => {
        d.stop().finally(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      process.stderr.write(`[workerking] daemon failed to start: ${String(err)}\n`);
      process.exit(1);
    });
}
