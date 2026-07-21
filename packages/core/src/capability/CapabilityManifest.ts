import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  deriveRoutingHints,
  type CapabilityManifest,
  type CapabilityManifestEntry,
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

/** Char budget for the whole capability summary — keeps the voice prompt frugal. */
const VOICE_SUMMARY_MAX_CHARS = 1500;

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
    const description = c.description ?? '';
    entries.push({
      kind: 'command',
      name: c.name,
      description,
      ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
      source: 'user',
      routingHints: deriveRoutingHints(c.name, description),
    });
  }
  for (const a of agents) {
    const description = a.description ?? '';
    entries.push({
      kind: 'agent',
      name: a.name,
      description,
      source: 'user',
      routingHints: deriveRoutingHints(a.name, description),
    });
  }
  for (const m of mcp) {
    const description = `MCP server (${m.status})`;
    entries.push({
      kind: 'mcp_server',
      name: m.name,
      description,
      source: 'user',
      status: mapMcpStatus(m.status),
      routingHints: deriveRoutingHints(m.name, ''),
    });
  }
  return entries;
}

/** One "- name <args> — description" bullet, trimmed of an empty description. */
function entryLine(e: CapabilityManifestEntry): string {
  const head = e.argumentHint ? `${e.name} ${e.argumentHint}` : e.name;
  const desc = e.description.replace(/\s+/g, ' ').trim();
  return desc ? `- ${head} — ${desc}` : `- ${head}`;
}

/**
 * Render a compact, char-budgeted summary for the thin voice model. Unlike the
 * old name-only list, each item carries its one-line description (and commands
 * their argument hint) so the model can route accurately. Grouped by category;
 * overflow past the budget collapses to a "(+N more)" marker per group.
 */
export function renderVoiceSummary(entries: CapabilityManifestEntry[]): string {
  const skills = entries.filter((e) => e.kind === 'skill' || e.kind === 'command');
  const agents = entries.filter((e) => e.kind === 'agent');
  const mcp = entries.filter(
    (e) => (e.kind === 'mcp_server' || e.kind === 'mcp_tool') && e.status === 'connected',
  );

  let budget = VOICE_SUMMARY_MAX_CHARS;
  const section = (title: string, group: CapabilityManifestEntry[]): string | undefined => {
    if (!group.length) return undefined;
    const rows: string[] = [];
    let shown = 0;
    for (const e of group) {
      const line = entryLine(e);
      if (budget - line.length < 0) break;
      rows.push(line);
      budget -= line.length + 1;
      shown++;
    }
    const more = group.length - shown;
    const header = more > 0 ? `${title} (+${more} more):` : `${title}:`;
    return rows.length ? `${header}\n${rows.join('\n')}` : `${header} (+${more} more)`;
  };

  const parts = [
    section('Skills/commands you can run', skills),
    section('Agents you can delegate to', agents),
    section('Connected tools/services', mcp),
  ].filter((s): s is string => Boolean(s));

  if (!parts.length) return 'No custom skills or tools are configured yet.';
  parts.push('Ask me to list everything if you want the full set.');
  return parts.join('\n\n');
}

/** A never-ending user-message stream so the session stays open while we read. */
async function* pendingInput(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
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
export async function buildCapabilityManifest(
  deps: BuildManifestDeps,
): Promise<CapabilityManifest> {
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
