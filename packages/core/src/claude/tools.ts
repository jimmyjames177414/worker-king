import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { ScreenContextProvider } from '../screen/ScreenContextProvider.js';
import type { MemoryStore, MemoryScope } from '../memory/MemoryStore.js';

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

export interface WorkerKingToolDeps {
  config: Pick<ConfigStore, 'get'>;
  screen: ScreenContextProvider;
  /** Optional memory store; enables the `remember` tool when present. */
  memory?: MemoryStore;
  /** Audit sink; every screen/memory access is recorded. */
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

/** The MCP server config to hand to ClaudeBackend `mcpServers`. */
export function createWorkerKingToolServer(deps: WorkerKingToolDeps): McpServerConfig {
  const { getActiveWindow, captureScreen } = buildScreenTools(deps);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Array<SdkMcpToolDefinition<any>> = [getActiveWindow, captureScreen];
  if (deps.memory) tools.push(buildMemoryTool(deps));
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
];
