import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Brain } from '../brain/Brain.js';
import { createLogger, type Logger } from '../util/logger.js';

/**
 * ClaudeBackend — the real brain, backed by the Claude Agent SDK.
 *
 * Phase 1 uses one `query()` per user message with session `resume` for
 * conversation continuity. This is the simplest thing that works for text chat:
 * robust, easy to test, and it draws on the user's Claude subscription with no
 * API key (the SDK inherits the local Claude Code login).
 *
 * Phase 3 (voice) upgrades this to a single long-lived streaming-input session
 * for lower latency + interrupts; the `Brain.respond` contract stays the same,
 * so the Supervisor and WS plumbing are unaffected by that swap.
 *
 * The `query` function is injected (defaulting to the SDK's) so the whole class
 * is testable headless without a real Claude login: a fake queryFn replays
 * canned SDK messages.
 */

/** Minimal structural type for the SDK `query` — the real export is assignable. */
export type ClaudeQueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

export interface ClaudeBackendOptions {
  /** Injected for tests; defaults to the SDK's query at construction. */
  queryFn: ClaudeQueryFn;
  /** Working directory for the Claude Code session. */
  cwd?: string;
  /**
   * Live working-directory provider (read per message) — lets a settings change
   * repoint Claude at another project without a restart. Takes precedence over
   * `cwd`; when it returns a different dir, the session is reset so context from
   * the previous project doesn't leak (F1).
   */
  cwdProvider?: () => string | undefined;
  /** Persona appended to Claude Code's preset system prompt. */
  personaAppend?: string;
  /**
   * Live persona provider (read per message) — lets settings/character-card
   * changes apply without restarting. Takes precedence over `personaAppend`.
   */
  personaProvider?: () => string;
  /** Permission posture for autonomous tool use. Phase 1 keeps the default. */
  permissionMode?: Options['permissionMode'];
  /**
   * Per-call permission gate for the Claude Code toolset (N1). When set, the SDK
   * asks it before running a tool that isn't pre-allowed — WorkerKing uses it to
   * confirm/deny destructive tools (Bash/Write/Edit).
   */
  canUseTool?: Options['canUseTool'];
  /** Safety cap on turns per message. */
  maxTurns?: number;
  /** In-process SDK MCP servers (e.g. WorkerKing's screen-awareness tools). */
  mcpServers?: Options['mcpServers'];
  /** Tool names allowed without a permission prompt (e.g. the WorkerKing tools). */
  allowedTools?: string[];
  /** Structured logger (defaults to a child of the root daemon logger). */
  log?: Logger;
}

/**
 * Optional richer execution handlers for the live activity feed. Layered on top
 * of the existing `onDelta`/`onToolUse` (which stay the source of truth for the
 * streamed reply text and the throttled voice progress); all are optional so the
 * voice/chat paths that don't want a feed pay nothing.
 */
export interface ActivityHandlers {
  /** A tool call started, with its full input (path/command/args). */
  onToolInput?: (u: { id: string; name: string; input: unknown }) => void;
  /** A tool call returned; correlate to onToolInput by `toolId`. */
  onToolResult?: (r: { toolId: string; isError: boolean; content: unknown }) => void;
  /** A complete thinking block. */
  onThinking?: (text: string) => void;
}

export class ClaudeAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeAuthError';
  }
}

/**
 * A rate-limit / usage-cap failure (HTTP 429, "usage limit reached", a Pro/Max
 * 5-hour cap, or an overloaded backend). Surfaced distinctly so the daemon can
 * tell the user to wait instead of showing a generic error — the lesson from
 * cybara/cicero that a limit is a first-class, retryable condition.
 */
export class ClaudeRateLimitError extends Error {
  constructor(
    message: string,
    /** Seconds to wait before retrying, if the backend hinted one. */
    readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = 'ClaudeRateLimitError';
  }
}

/** Token/cost accounting pulled from an SDK `result` message. */
export interface ClaudeUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
}

export class ClaudeBackend implements Brain {
  readonly id = 'claude';
  private sessionId: string | undefined;
  /** Working dir the current session belongs to; used to detect a repo switch. */
  private lastCwd: string | undefined;
  private cwdInitialized = false;
  /** Usage from the most recent completed turn (N9 — feeds budget awareness). */
  private lastUsage: ClaudeUsage | undefined;
  private readonly log: Logger;

  constructor(private readonly opts: ClaudeBackendOptions) {
    this.log = opts.log ?? createLogger({ scope: 'claude' });
  }

  private buildOptions(o: { resume?: boolean; cwdOverride?: string } = {}): Options {
    const append = this.opts.personaProvider?.() ?? this.opts.personaAppend;
    const cwd = o.cwdOverride ?? this.opts.cwdProvider?.() ?? this.opts.cwd;
    // Repoint to a different project → don't resume the old project's session
    // (F1). A one-shot task override is NOT a repoint: it must neither reset the
    // chat session nor pollute the cwd tracking the chat path relies on.
    if (!o.cwdOverride) {
      if (this.cwdInitialized && cwd !== this.lastCwd) {
        // This is a real, user-visible discontinuity: the next reply starts a
        // fresh Claude session with no memory of the conversation so far. Log it
        // at 'warn' (not 'info') so it stands out in a "why did the AI forget
        // everything / seem to reset" investigation.
        this.log.warn('session reset: cwd changed', {
          from: this.lastCwd,
          to: cwd,
          droppedSessionId: this.sessionId,
        });
        this.sessionId = undefined;
      }
      this.lastCwd = cwd;
      this.cwdInitialized = true;
    }
    const options: Options = {
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(append ? { append } : {}),
      },
      includePartialMessages: true,
      // SDK isolation mode: never load ~/.claude or the cwd's .claude settings.
      // Without this, `permissions.allow` rules from those files (including a
      // hostile repo's .claude/settings.json reached via claudeCwd) auto-allow
      // tools without ever consulting canUseTool — silently bypassing both the
      // gated confirmation (N1) and the readonly posture of background brains.
      settingSources: [],
      ...(cwd ? { cwd } : {}),
      ...(this.opts.permissionMode ? { permissionMode: this.opts.permissionMode } : {}),
      ...(this.opts.canUseTool ? { canUseTool: this.opts.canUseTool } : {}),
      ...(this.opts.maxTurns ? { maxTurns: this.opts.maxTurns } : {}),
      ...(this.opts.mcpServers ? { mcpServers: this.opts.mcpServers } : {}),
      ...(this.opts.allowedTools ? { allowedTools: this.opts.allowedTools } : {}),
      ...(o.resume !== false && this.sessionId ? { resume: this.sessionId } : {}),
    };
    return options;
  }

  /**
   * The single SDK message loop shared by `respond()` and `run()`. Handles the
   * `stream_event` → text-delta, `assistant` → tool_use, and `result` →
   * session/usage/terminal-subtype cases in one place, so the two entry points
   * never drift. Returns the final result string; throws (normalized) on a
   * non-success terminal subtype.
   */
  private async consume(
    iterable: AsyncIterable<SDKMessage>,
    handlers: {
      onDelta?: (delta: string) => void;
      onToolUse?: (name: string) => void;
    } & ActivityHandlers,
    o: { trackSession?: boolean } = {},
  ): Promise<string> {
    let resultText = '';
    for await (const msg of iterable) {
      // Sub-agent (Task) streams carry parent_tool_use_id — their internal text
      // and nested tool calls must not interleave into the top-level view. The
      // parent `Task` tool_use itself is top-level and still shows.
      const nested = Boolean((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id);
      switch (msg.type) {
        case 'stream_event': {
          if (nested) break;
          const delta = extractTextDelta(msg.event);
          if (delta) handlers.onDelta?.(delta);
          break;
        }
        case 'assistant': {
          if (handlers.onToolUse) {
            for (const name of extractToolUses(msg)) {
              this.log.debug('tool_use', { name });
              handlers.onToolUse(name);
            }
          }
          if (!nested && handlers.onToolInput) {
            for (const u of extractToolUseBlocks(msg)) handlers.onToolInput(u);
          }
          if (!nested && handlers.onThinking) {
            for (const t of extractThinking(msg)) handlers.onThinking(t);
          }
          break;
        }
        case 'user': {
          // A tool_result arrives as a subsequent user message. Surfaced only for
          // the activity feed; text still arrives via stream_event.
          if (!nested && handlers.onToolResult) {
            for (const r of extractToolResults(msg)) handlers.onToolResult(r);
          }
          break;
        }
        case 'result': {
          // Persist the session id so the next message continues the thread
          // (chat only — task runs are sessionless, see run()), and record
          // usage for budget/observability (N9).
          if (o.trackSession !== false) this.sessionId = msg.session_id;
          this.lastUsage = extractUsage(msg);
          if (msg.subtype === 'success') resultText = msg.result;
          else {
            this.log.warn('turn ended non-success', {
              subtype: msg.subtype,
              sessionId: msg.session_id,
            });
            throw this.normalizeError(new Error(`Claude ended with "${msg.subtype}"`), msg.subtype);
          }
          break;
        }
        default:
          // system/etc. — ignored; text arrives via stream_event.
          break;
      }
    }
    return resultText;
  }

  async respond(
    text: string,
    onDelta: (delta: string) => void,
    activity?: ActivityHandlers,
  ): Promise<string> {
    let streamed = '';
    let resultText: string;
    const resuming = Boolean(this.sessionId);
    this.log.debug('respond start', {
      chars: text.length,
      resuming,
      sessionId: this.sessionId,
    });
    try {
      const iterable = this.opts.queryFn({ prompt: text, options: this.buildOptions() });
      resultText = await this.consume(iterable, {
        onDelta: (d) => {
          streamed += d;
          onDelta(d);
        },
        ...activity,
      });
    } catch (err) {
      const normalized = this.normalizeError(err);
      this.log.warn('respond failed', {
        kind: normalized.name,
        error: normalized.message,
        resuming,
      });
      throw normalized;
    }
    // The streamed text is what the user watched appear; prefer it. Fall back to
    // the result string if partial streaming produced nothing (e.g. a terse turn).
    const final = streamed.length > 0 ? streamed : resultText;
    this.log.debug('respond done', { chars: final.length, sessionId: this.sessionId });
    return final;
  }

  /**
   * TaskRunner implementation for delegated (voice) work: streams richer events
   * (text deltas + tool_use starts + final result) so the TaskManager can map
   * them to spoken progress. Honors the abort signal for cancel_task.
   */
  async run(
    prompt: string,
    events: {
      onDelta(text: string): void;
      onToolUse(name: string): void;
      onDone(summary: string): void;
      onError(err: Error): void;
    } & ActivityHandlers,
    signal: AbortSignal,
    runOpts?: { cwd?: string },
  ): Promise<void> {
    // A task cancelled while the brain was still warming arrives pre-aborted;
    // addEventListener on an aborted signal never fires, so check up front or
    // the "cancelled" run burns a full Claude query with its events suppressed.
    if (signal.aborted) return;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    // Delegated tasks are sessionless on purpose: sharing the chat session
    // would leak chat context into tasks and let concurrent task completions
    // hijack which thread the *next chat message* resumes (last-writer-wins).
    const options: Options = {
      ...this.buildOptions({ resume: false, cwdOverride: runOpts?.cwd }),
      abortController: abort,
    };
    try {
      const resultText = await this.consume(
        this.opts.queryFn({ prompt, options }),
        {
          onDelta: events.onDelta,
          onToolUse: events.onToolUse,
          onToolInput: events.onToolInput,
          onToolResult: events.onToolResult,
          onThinking: events.onThinking,
        },
        { trackSession: false },
      );
      if (!signal.aborted) events.onDone(resultText || 'Done.');
    } catch (err) {
      const normalized = this.normalizeError(err);
      this.log.warn('task run failed', { kind: normalized.name, error: normalized.message });
      if (!signal.aborted) events.onError(normalized);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Reset conversation continuity (start a fresh Claude session next message). */
  resetSession(): void {
    if (this.sessionId)
      this.log.debug('session reset: explicit', { droppedSessionId: this.sessionId });
    this.sessionId = undefined;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Usage from the most recent completed turn (undefined until one finishes). */
  getLastUsage(): ClaudeUsage | undefined {
    return this.lastUsage;
  }

  private normalizeError(err: unknown, subtype?: string): Error {
    // Already classified — don't re-wrap (keeps normalization idempotent when a
    // thrown error passes through more than one catch).
    if (err instanceof ClaudeAuthError || err instanceof ClaudeRateLimitError) return err;

    const message = err instanceof Error ? err.message : String(err);

    // Rate limit / usage cap (checked before auth: a 429 mentioning "login" is
    // still a limit). Surfaced as a distinct, retryable condition.
    if (
      /rate.?limit|\b429\b|too many requests|usage limit|quota exceeded|overloaded|capacity/i.test(
        message,
      ) ||
      subtype === 'error_rate_limit' ||
      subtype === 'error_usage_limit'
    ) {
      const m = /retry[- ]after[:\s]+(\d+)/i.exec(message);
      return new ClaudeRateLimitError(
        'Claude is rate-limited or over its usage cap right now. Try again shortly.',
        m ? Number(m[1]) : undefined,
      );
    }

    // Auth/login problems: prompt the user to run `claude login` instead of
    // looking broken.
    if (
      /not logged in|unauthor|authentication|login|401|invalid api key|no credentials/i.test(
        message,
      ) ||
      subtype === 'error_auth'
    ) {
      return new ClaudeAuthError(
        'Claude is not authenticated. Run `claude login` (Pro/Max) or set ANTHROPIC_API_KEY.',
      );
    }
    return err instanceof Error ? err : new Error(message);
  }
}

/** Pull token/cost accounting out of an SDK `result` message (loosely typed). */
export function extractUsage(msg: unknown): ClaudeUsage | undefined {
  const m = msg as {
    usage?: { input_tokens?: number; output_tokens?: number };
    total_cost_usd?: number;
  };
  if (!m || typeof m !== 'object') return undefined;
  const usage: ClaudeUsage = {};
  if (typeof m.usage?.input_tokens === 'number') usage.inputTokens = m.usage.input_tokens;
  if (typeof m.usage?.output_tokens === 'number') usage.outputTokens = m.usage.output_tokens;
  if (typeof m.total_cost_usd === 'number') usage.totalCostUsd = m.total_cost_usd;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Pull text out of a Beta raw message stream event. We only care about
 * `content_block_delta` events carrying a `text_delta`. Typed loosely because
 * the SDK's BetaRawMessageStreamEvent is a wide union; we guard at runtime.
 */
export function extractTextDelta(event: unknown): string | undefined {
  if (!event || typeof event !== 'object') return undefined;
  const e = event as { type?: string; delta?: { type?: string; text?: string } };
  if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
    return e.delta.text ?? undefined;
  }
  return undefined;
}

/** Extract tool_use block names from an assistant SDK message. */
export function extractToolUses(msg: unknown): string[] {
  const m = msg as { message?: { content?: Array<{ type?: string; name?: string }> } };
  const content = m?.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b.type === 'tool_use' && b.name).map((b) => b.name as string);
}

/**
 * Extract full tool_use blocks (id + name + input) from an assistant message —
 * the activity feed needs the id (to pair a result) and the input (to summarize).
 */
export function extractToolUseBlocks(
  msg: unknown,
): Array<{ id: string; name: string; input: unknown }> {
  const m = msg as {
    message?: { content?: Array<{ type?: string; id?: string; name?: string; input?: unknown }> };
  };
  const content = m?.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === 'tool_use' && b.id && b.name)
    .map((b) => ({ id: b.id as string, name: b.name as string, input: b.input }));
}

/**
 * Extract tool_result blocks from a user SDK message (the SDK feeds tool output
 * back as a user turn). `tool_use_id` correlates each result to its tool_use.
 */
export function extractToolResults(
  msg: unknown,
): Array<{ toolId: string; isError: boolean; content: unknown }> {
  const m = msg as {
    message?: {
      content?: Array<{
        type?: string;
        tool_use_id?: string;
        is_error?: boolean;
        content?: unknown;
      }>;
    };
  };
  const content = m?.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === 'tool_result' && b.tool_use_id)
    .map((b) => ({
      toolId: b.tool_use_id as string,
      isError: Boolean(b.is_error),
      content: b.content,
    }));
}

/** Extract complete thinking-block text from an assistant SDK message. */
export function extractThinking(msg: unknown): string[] {
  const m = msg as { message?: { content?: Array<{ type?: string; thinking?: string }> } };
  const content = m?.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b) => b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.length > 0)
    .map((b) => b.thinking as string);
}
