import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { ScreenContextProvider } from '../screen/ScreenContextProvider.js';
import type { MemoryStore, MemoryScope } from '../memory/MemoryStore.js';
import { KeywordMemoryIndex } from '../memory/MemoryIndex.js';
import type { MemoryEntry } from '../memory/MemoryStore.js';

/**
 * WorkerKing's in-process SDK tools, exposed to Claude via createSdkMcpServer.
 *
 * Phase 2 ships screen awareness: `get_active_window` and `capture_screen`. Both
 * are GATED by the `screenAwareness` config flag (default off) and audit-logged on
 * every call — if the feature is disabled the tool returns an error the model can
 * relay ("screen awareness is turned off"). Future phases add speak/notify/
 * set_avatar_state/remember here behind the same server.
 *
 * Tool names surface to Claude as `mcp__workerking__<tool>`; add those to the
 * ClaudeBackend `allowedTools` so they run without a permission prompt.
 */

export const WORKERKING_MCP_SERVER_NAME = 'workerking';

export interface ProactiveNotice {
  text: string;
  level?: 'info' | 'warn' | 'success';
  speak?: boolean;
  source?: string;
}

export interface WorkerKingToolDeps {
  config: Pick<ConfigStore, 'get'>;
  screen: ScreenContextProvider;
  /** Optional memory store; enables the `remember` tool when present. */
  memory?: MemoryStore;
  /** Surface a proactive heads-up (toast + optional speech); enables `notify`. */
  proactiveNotify?: (notice: ProactiveNotice) => void;
  /** Schedule a reminder, returning its id; enables `set_reminder`. */
  scheduleReminder?: (message: string, fireAtMs: number) => string;
  /** Wall clock for reminder timing (injected in tests). */
  now?: () => number;
  /** Audit sink; every screen/memory/proactive access is recorded. */
  audit?: (event: { tool: string; detail: string }) => void;
}

function screenDisabledResult() {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text:
          'Screen awareness is turned OFF. Tell the user to enable it in WorkerKing settings ' +
          '(screenAwareness) if they want you to see their screen.',
      },
    ],
  };
}

export function buildScreenTools(deps: WorkerKingToolDeps) {
  const enabled = () => deps.config.get('screenAwareness') === true;

  const getActiveWindow = tool(
    'get_active_window',
    "Get the title of the user's current foreground window/app. Use when the user " +
      'refers to what they are looking at ("this window", "what am I on"). Requires ' +
      'screen awareness to be enabled.',
    {},
    async () => {
      deps.audit?.({ tool: 'get_active_window', detail: 'requested' });
      if (!enabled()) return screenDisabledResult();
      const ctx = await deps.screen.capture({ target: 'window', includeImage: false });
      if (!ctx.ok) {
        return { isError: true, content: [{ type: 'text' as const, text: ctx.error ?? 'capture failed' }] };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Active window: ${ctx.activeWindowTitle ?? '(unknown title)'}`,
          },
        ],
      };
    },
  );

  const captureScreen = tool(
    'capture_screen',
    "Take a screenshot of the user's screen (or foreground window) and view it. Use " +
      'when the user asks about something visual on screen ("what does this say", ' +
      '"read this error"). Requires screen awareness to be enabled.',
    { target: z.enum(['window', 'screen']).default('window') },
    async (args) => {
      deps.audit?.({ tool: 'capture_screen', detail: `target=${args.target}` });
      if (!enabled()) return screenDisabledResult();
      const ctx = await deps.screen.capture({ target: args.target, includeImage: true });
      if (!ctx.ok || !ctx.imageBase64) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: ctx.error ?? 'screenshot failed' }],
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Screenshot of ${args.target}${
              ctx.activeWindowTitle ? ` (${ctx.activeWindowTitle})` : ''
            }:`,
          },
          { type: 'image' as const, data: ctx.imageBase64, mimeType: 'image/png' },
        ],
      };
    },
  );

  return { getActiveWindow, captureScreen };
}

/**
 * The `remember` tool: lets Claude persist a durable fact/preference about the
 * user mid-task. Gated by `memoryEnabled` (default true). Stored memories are
 * injected into the persona so they're recalled in later sessions.
 */
export function buildMemoryTool(deps: WorkerKingToolDeps) {
  const enabled = () => deps.config.get('memoryEnabled') !== false && !!deps.memory;
  return tool(
    'remember',
    'Persist a durable fact or preference about the user so you recall it in future ' +
      'sessions (e.g. their name, tools they use, how they like things done). Use a short ' +
      'stable key. Updating the same key overwrites the old value.',
    {
      key: z.string().describe('Short stable identifier, e.g. "editor" or "timezone".'),
      value: z.string().describe('The fact to remember.'),
      scope: z.enum(['preference', 'fact', 'project']).default('fact'),
    },
    async (args) => {
      deps.audit?.({ tool: 'remember', detail: `${args.key}=${args.value}` });
      if (!enabled()) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'Memory is turned off in WorkerKing settings.' }],
        };
      }
      deps.memory!.remember(args.key, args.value, args.scope as MemoryScope, 'remember-tool');
      return { content: [{ type: 'text' as const, text: `Remembered "${args.key}".` }] };
    },
  );
}

function memoryDisabledResult() {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: 'Memory is turned off in WorkerKing settings.' }],
  };
}

function formatEntries(entries: MemoryEntry[]): string {
  return entries.map((e) => `- (${e.scope}) ${e.key}: ${e.value}`).join('\n');
}

/**
 * The `recall` tool: lets Claude query durable memory mid-task instead of relying
 * only on the persona summary injected at boot. Ranked keyword search via
 * KeywordMemoryIndex. Gated by `memoryEnabled`.
 */
export function buildRecallTool(deps: WorkerKingToolDeps) {
  const enabled = () => deps.config.get('memoryEnabled') !== false && !!deps.memory;
  return tool(
    'recall',
    'Search your durable memory of the user for facts/preferences relevant to a query ' +
      '(e.g. "editor", "timezone", "how they like PRs"). Returns the best matches. Use before ' +
      'asking the user something you may already know.',
    {
      query: z.string().describe('What to look for, e.g. "coffee" or "preferred editor".'),
      scope: z.enum(['preference', 'fact', 'project']).optional().describe('Optional scope filter.'),
      limit: z.number().int().positive().max(25).default(5),
    },
    async (args) => {
      deps.audit?.({ tool: 'recall', detail: `query=${args.query}` });
      if (!enabled()) return memoryDisabledResult();
      const index = new KeywordMemoryIndex(deps.memory!);
      const hits = index.search(args.query, { scope: args.scope as MemoryScope | undefined, limit: args.limit });
      if (!hits.length) {
        return { content: [{ type: 'text' as const, text: `No memories match "${args.query}".` }] };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Found ${hits.length} matching ${hits.length === 1 ? 'memory' : 'memories'}:\n${formatEntries(hits)}`,
          },
        ],
      };
    },
  );
}

/**
 * The `list_memories` tool: dump everything currently remembered (optionally by
 * scope) so Claude can review the full set. Gated by `memoryEnabled`.
 */
export function buildListMemoriesTool(deps: WorkerKingToolDeps) {
  const enabled = () => deps.config.get('memoryEnabled') !== false && !!deps.memory;
  return tool(
    'list_memories',
    'List everything you currently remember about the user, newest first. Optionally filter by ' +
      'scope. Use when the user asks what you know/remember about them.',
    {
      scope: z.enum(['preference', 'fact', 'project']).optional().describe('Optional scope filter.'),
    },
    async (args) => {
      deps.audit?.({ tool: 'list_memories', detail: args.scope ? `scope=${args.scope}` : 'all' });
      if (!enabled()) return memoryDisabledResult();
      const index = new KeywordMemoryIndex(deps.memory!);
      const entries = index.list({ scope: args.scope as MemoryScope | undefined });
      if (!entries.length) {
        return { content: [{ type: 'text' as const, text: 'You have no memories stored yet.' }] };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `You remember ${entries.length} ${entries.length === 1 ? 'thing' : 'things'}:\n${formatEntries(entries)}`,
          },
        ],
      };
    },
  );
}

/** The `notify` tool: Claude proactively surfaces a heads-up (toast + optional speech). */
export function buildNotifyTool(deps: WorkerKingToolDeps) {
  return tool(
    'notify',
    'Proactively surface a short heads-up to the user (a desktop toast, spoken aloud by default). ' +
      'Use to tell them something worth their attention now — a task finished, something needs them.',
    {
      text: z.string().describe('The heads-up, phrased for the user.'),
      level: z.enum(['info', 'warn', 'success']).default('info'),
      speak: z.boolean().default(true),
    },
    async (args) => {
      deps.audit?.({ tool: 'notify', detail: args.text });
      deps.proactiveNotify?.({ text: args.text, level: args.level, speak: args.speak, source: 'notify-tool' });
      return { content: [{ type: 'text' as const, text: 'Notified the user.' }] };
    },
  );
}

/** The `set_reminder` tool: schedule a message to surface later. */
export function buildReminderTool(deps: WorkerKingToolDeps) {
  const now = () => (deps.now ?? (() => Date.now()))();
  return tool(
    'set_reminder',
    'Remind the user of something later. Give either delaySeconds (from now) or atISO (an absolute ' +
      'time). The reminder is spoken + toasted when it fires and survives restarts.',
    {
      message: z.string().describe('What to remind them.'),
      delaySeconds: z.number().int().positive().optional(),
      atISO: z.string().optional().describe('Absolute ISO 8601 time, e.g. 2026-07-13T17:00:00Z.'),
    },
    async (args) => {
      if (deps.config.get('remindersEnabled') === false || !deps.scheduleReminder) {
        return { isError: true, content: [{ type: 'text' as const, text: 'Reminders are turned off.' }] };
      }
      let fireAt: number | undefined;
      if (args.delaySeconds) fireAt = now() + args.delaySeconds * 1000;
      else if (args.atISO) {
        const t = Date.parse(args.atISO);
        if (!Number.isNaN(t)) fireAt = t;
      }
      if (!fireAt || fireAt <= now()) {
        return { isError: true, content: [{ type: 'text' as const, text: 'Need a valid future time (delaySeconds or atISO).' }] };
      }
      deps.audit?.({ tool: 'set_reminder', detail: `${args.message} @ ${new Date(fireAt).toISOString()}` });
      const id = deps.scheduleReminder(args.message, fireAt);
      return { content: [{ type: 'text' as const, text: `Reminder set (${id}).` }] };
    },
  );
}

/** The MCP server config to hand to ClaudeBackend `mcpServers`. */
export function createWorkerKingToolServer(deps: WorkerKingToolDeps): McpServerConfig {
  const { getActiveWindow, captureScreen } = buildScreenTools(deps);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Array<SdkMcpToolDefinition<any>> = [getActiveWindow, captureScreen];
  if (deps.memory) tools.push(buildMemoryTool(deps), buildRecallTool(deps), buildListMemoriesTool(deps));
  if (deps.proactiveNotify) tools.push(buildNotifyTool(deps));
  if (deps.scheduleReminder) tools.push(buildReminderTool(deps));
  return createSdkMcpServer({
    name: WORKERKING_MCP_SERVER_NAME,
    version: '0.0.0',
    tools,
  });
}

/** Tool names to allow without a permission prompt. */
export const WORKERKING_TOOL_ALLOWLIST = [
  `mcp__${WORKERKING_MCP_SERVER_NAME}__get_active_window`,
  `mcp__${WORKERKING_MCP_SERVER_NAME}__capture_screen`,
  `mcp__${WORKERKING_MCP_SERVER_NAME}__remember`,
  `mcp__${WORKERKING_MCP_SERVER_NAME}__recall`,
  `mcp__${WORKERKING_MCP_SERVER_NAME}__list_memories`,
  `mcp__${WORKERKING_MCP_SERVER_NAME}__notify`,
  `mcp__${WORKERKING_MCP_SERVER_NAME}__set_reminder`,
];
