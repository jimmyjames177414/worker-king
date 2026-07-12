import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ConfigStore } from '../config/ConfigStore.js';
import type { ScreenContextProvider } from '../screen/ScreenContextProvider.js';

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
  /** Audit sink; every screen access is recorded. */
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

/** The MCP server config to hand to ClaudeBackend `mcpServers`. */
export function createWorkerKingToolServer(deps: WorkerKingToolDeps): McpServerConfig {
  const { getActiveWindow, captureScreen } = buildScreenTools(deps);
  return createSdkMcpServer({
    name: WORKERKING_MCP_SERVER_NAME,
    version: '0.0.0',
    tools: [getActiveWindow, captureScreen],
  });
}

/** Tool names to allow without a permission prompt. */
export const WORKERKING_TOOL_ALLOWLIST = [
  `mcp__${WORKERKING_MCP_SERVER_NAME}__get_active_window`,
  `mcp__${WORKERKING_MCP_SERVER_NAME}__capture_screen`,
];
