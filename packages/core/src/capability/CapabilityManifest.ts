import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  CapabilityManifest,
  CapabilityManifestEntry,
} from '@workerking/shared';

/**
 * CapabilityManifest — how WorkerKing "knows all it can do".
 *
 * Builds a manifest from the Agent SDK's introspection methods
 * (`supportedCommands` / `supportedAgents` / `mcpServerStatus`) so the voice
 * layer can describe and route to the user's skills/commands/agents/MCP servers,
 * and refresh live as they add more. The query fn is injected so the mapping is
 * unit-testable without a real Claude session.
 */

/** Minimal handle we need off the SDK Query — the real Query is assignable. */
export interface CapabilityQueryHandle {
  supportedCommands(): Promise<Array<{ name: string; description: string; argumentHint?: string }>>;
  supportedAgents(): Promise<Array<{ name: string; description: string; model?: string }>>;
  mcpServerStatus(): Promise<Array<{ name: string; status: string }>>;
}

export type CapabilityQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => CapabilityQueryHandle;

/** Fraction of the (rough) voice context to spend on the capability summary. */
const VOICE_SUMMARY_MAX_ITEMS = 12;

function mapMcpStatus(status: string): 'connected' | 'error' | 'pending' {
  if (status === 'connected') return 'connected';
  if (status === 'pending') return 'pending';
  return 'error';
}

/** Turn the raw SDK introspection into normalized manifest entries. */
export function mapToEntries(
  commands: Array<{ name: string; description: string; argumentHint?: string }>,
  agents: Array<{ name: string; description: string }>,
  mcp: Array<{ name: string; status: string }>,
): CapabilityManifestEntry[] {
  const entries: CapabilityManifestEntry[] = [];

  for (const c of commands) {
    entries.push({
      kind: 'skill',
      name: c.name,
      description: c.description ?? '',
      source: 'user',
    });
  }
  for (const a of agents) {
    entries.push({
      kind: 'agent',
      name: a.name,
      description: a.description ?? '',
      source: 'user',
    });
  }
  for (const m of mcp) {
    entries.push({
      kind: 'mcp_server',
      name: m.name,
      description: `MCP server (${m.status})`,
      source: 'user',
      status: mapMcpStatus(m.status),
    });
  }
  return entries;
}

/**
 * Render a compact, budget-capped summary for the thin voice model. Groups by
 * category, caps the item list, and tells the model to ask for the full set.
 */
export function renderVoiceSummary(entries: CapabilityManifestEntry[]): string {
  const skills = entries.filter((e) => e.kind === 'skill' || e.kind === 'command');
  const agents = entries.filter((e) => e.kind === 'agent');
  const mcp = entries.filter((e) => e.kind === 'mcp_server' || e.kind === 'mcp_tool');

  const lines: string[] = [];
  if (skills.length) {
    const shown = skills.slice(0, VOICE_SUMMARY_MAX_ITEMS).map((s) => s.name).join(', ');
    const more = skills.length > VOICE_SUMMARY_MAX_ITEMS ? ` (+${skills.length - VOICE_SUMMARY_MAX_ITEMS} more)` : '';
    lines.push(`Skills/commands you can run: ${shown}${more}.`);
  }
  if (agents.length) {
    lines.push(`Agents available: ${agents.slice(0, 8).map((a) => a.name).join(', ')}.`);
  }
  if (mcp.length) {
    const connected = mcp.filter((m) => m.status === 'connected').map((m) => m.name);
    if (connected.length) lines.push(`Connected tools/services: ${connected.join(', ')}.`);
  }
  if (!lines.length) return 'No custom skills or tools are configured yet.';
  lines.push('Ask me to list everything if you want the full set.');
  return lines.join(' ');
}

/** A never-ending user-message stream so the session stays open while we read. */
async function* pendingInput(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

export interface BuildManifestDeps {
  queryFn: CapabilityQueryFn;
  options?: Options;
  version: number;
  now: () => number;
}

/**
 * Build one manifest snapshot. Opens a query (with a pending input so the session
 * initializes), reads the three introspection methods, then aborts to close it.
 */
export async function buildCapabilityManifest(deps: BuildManifestDeps): Promise<CapabilityManifest> {
  const abort = new AbortController();
  const options: Options = { ...deps.options, abortController: abort };
  const q = deps.queryFn({ prompt: pendingInput(abort.signal), options });

  try {
    const [commands, agents, mcp] = await Promise.all([
      q.supportedCommands().catch(() => []),
      q.supportedAgents().catch(() => []),
      q.mcpServerStatus().catch(() => []),
    ]);
    const entries = mapToEntries(commands, agents, mcp);
    return {
      version: deps.version,
      builtAt: deps.now(),
      entries,
      voiceSummary: renderVoiceSummary(entries),
    };
  } finally {
    abort.abort();
  }
}
