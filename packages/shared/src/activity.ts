/**
 * Activity helpers — turn raw Claude Code tool activity into small, safe,
 * display-ready strings for the live execution feed.
 *
 * These are pure and environment-agnostic on purpose: the daemon (`core`)
 * produces the strings before they cross the WS bus, and the renderer reuses the
 * truncation constants — but `shared` can import neither, so it owns them.
 *
 * This is a deliberately different register from `friendlyTool` in
 * `ProgressMapper` (voice: "running a command…"). The feed shows what the agent
 * literally did ("Bash", "npm test"); voice narrates it. Keep the two separate.
 */

/** Hard caps so a single step can never bloat the 16 MB WS payload. */
export const ACTIVITY_MAX_SUMMARY = 200;
export const ACTIVITY_MAX_PREVIEW = 200;
export const ACTIVITY_MAX_THINKING = 600;

/** Truncate to `max` chars with a trailing ellipsis (single-line, trimmed). */
function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Cap a thinking block for the feed (keeps newlines; just bounds length). */
export function truncateThinking(text: string): string {
  const t = text.trim();
  return t.length > ACTIVITY_MAX_THINKING ? `${t.slice(0, ACTIVITY_MAX_THINKING - 1)}…` : t;
}

/**
 * Display label for a tool name. Distinct from the spoken `friendlyTool`:
 *  - built-in tools keep their name (`Bash`, `Read`, `Edit`, …)
 *  - `mcp__server__tool` collapses to `server/tool`
 *  - anything else falls back to the raw name.
 */
export function activityLabel(name: string): string {
  const mcp = /^mcp__([^_]+)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]}/${mcp[2].replace(/_/g, ' ')}`;
  return name;
}

/** Read a string field off a loosely-typed tool input, if present. */
function field(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * The salient part of a tool's input — the file path, command, pattern, or URL
 * it's acting on — truncated for display. Unknown/MCP tools fall back to a
 * compact JSON dump. Never throws; always returns a bounded string.
 */
export function summarizeToolInput(name: string, input: unknown): string {
  const pick = (): string => {
    switch (name) {
      case 'Bash':
        return field(input, 'command') ?? '';
      case 'Read':
      case 'Write':
        return field(input, 'file_path') ?? '';
      case 'Edit':
      case 'MultiEdit':
        return field(input, 'file_path') ?? '';
      case 'Glob':
      case 'Grep': {
        const pat = field(input, 'pattern') ?? '';
        const path = field(input, 'path');
        return path ? `${pat} in ${path}` : pat;
      }
      case 'WebFetch':
        return field(input, 'url') ?? '';
      case 'WebSearch':
        return field(input, 'query') ?? '';
      case 'Task':
        return field(input, 'description') ?? field(input, 'prompt') ?? '';
      default: {
        // MCP / unknown tools: compact JSON of the input object.
        if (input == null) return '';
        try {
          return typeof input === 'string' ? input : JSON.stringify(input);
        } catch {
          return '';
        }
      }
    }
  };
  return truncate(pick(), ACTIVITY_MAX_SUMMARY);
}

/**
 * Normalize an SDK `tool_result.content` (a string, or an array of content
 * blocks) into a short, safe preview. Non-text blocks (images, binary) are
 * summarized rather than dumped. `ok` mirrors the block's `is_error` flag.
 */
export function previewToolResult(
  content: unknown,
  isError: boolean,
): { ok: boolean; preview: string } {
  const ok = !isError;
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        if (b && typeof b === 'object') {
          const block = b as { type?: string; text?: string };
          if (block.type === 'text' && typeof block.text === 'string') return block.text;
          if (block.type === 'image') return '[image]';
          return '[binary]';
        }
        return typeof b === 'string' ? b : '[binary]';
      })
      .join(' ');
  } else if (content == null) {
    text = '';
  } else {
    try {
      text = JSON.stringify(content);
    } catch {
      text = '';
    }
  }
  return { ok, preview: truncate(text, ACTIVITY_MAX_PREVIEW) };
}
