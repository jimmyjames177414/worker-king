import type { TaskProgress } from '@workerking/shared';

/**
 * ProgressMapper — turns raw Claude Code activity into throttled, voice-friendly
 * progress updates. Tool calls become short spoken status ("Running a command…");
 * text activity becomes an occasional heartbeat ("Still working…"). Throttled via
 * an injected clock so a busy task doesn't spam the user mid-conversation.
 */
export class ProgressMapper {
  // Negative infinity so the very first update always emits (never throttled).
  private lastEmit = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly now: () => number,
    private readonly throttleMs = 1500,
  ) {}

  /** A tool call started. Returns a progress item to speak, or undefined if throttled. */
  tool(name: string): TaskProgress | undefined {
    return this.maybe('tool', `Working on it — ${friendlyTool(name)}.`);
  }

  /** Text activity — emit an occasional heartbeat so long silences aren't scary. */
  heartbeat(): TaskProgress | undefined {
    return this.maybe('writing', 'Still working on that…');
  }

  private maybe(phase: TaskProgress['phase'], text: string): TaskProgress | undefined {
    const t = this.now();
    if (t - this.lastEmit < this.throttleMs) return undefined;
    this.lastEmit = t;
    return { ts: t, phase, text, spoken: false };
  }
}

/** Map a raw tool name to a short spoken phrase. */
export function friendlyTool(name: string): string {
  const map: Record<string, string> = {
    Bash: 'running a command',
    Read: 'reading a file',
    Write: 'writing a file',
    Edit: 'editing a file',
    Glob: 'searching for files',
    Grep: 'searching the code',
    WebFetch: 'reading a web page',
    WebSearch: 'searching the web',
    Task: 'delegating to a sub-agent',
  };
  if (map[name]) return map[name];
  // mcp__server__tool → "using <tool>"
  const mcp = /^mcp__[^_]+__(.+)$/.exec(name);
  if (mcp) return `using ${mcp[1].replace(/_/g, ' ')}`;
  return `using ${name}`;
}
