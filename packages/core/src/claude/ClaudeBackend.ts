import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Brain } from '../brain/Brain.js';

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

  constructor(private readonly opts: ClaudeBackendOptions) {}

  private buildOptions(): Options {
    const append = this.opts.personaProvider?.() ?? this.opts.personaAppend;
    const cwd = this.opts.cwdProvider?.() ?? this.opts.cwd;
    // Repoint to a different project → don't resume the old project's session (F1).
    if (this.cwdInitialized && cwd !== this.lastCwd) this.sessionId = undefined;
    this.lastCwd = cwd;
    this.cwdInitialized = true;
    const options: Options = {
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(append ? { append } : {}),
      },
      includePartialMessages: true,
      ...(cwd ? { cwd } : {}),
      ...(this.opts.permissionMode ? { permissionMode: this.opts.permissionMode } : {}),
      ...(this.opts.canUseTool ? { canUseTool: this.opts.canUseTool } : {}),
      ...(this.opts.maxTurns ? { maxTurns: this.opts.maxTurns } : {}),
      ...(this.opts.mcpServers ? { mcpServers: this.opts.mcpServers } : {}),
      ...(this.opts.allowedTools ? { allowedTools: this.opts.allowedTools } : {}),
      ...(this.sessionId ? { resume: this.sessionId } : {}),
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
    handlers: { onDelta?: (delta: string) => void; onToolUse?: (name: string) => void },
  ): Promise<string> {
    let resultText = '';
    for await (const msg of iterable) {
      switch (msg.type) {
        case 'stream_event': {
          const delta = extractTextDelta(msg.event);
          if (delta) handlers.onDelta?.(delta);
          break;
        }
        case 'assistant': {
          if (handlers.onToolUse) {
            for (const name of extractToolUses(msg)) handlers.onToolUse(name);
          }
          break;
        }
        case 'result': {
          // Persist the session id so the next message continues the thread,
          // and record usage for budget/observability (N9).
          this.sessionId = msg.session_id;
          this.lastUsage = extractUsage(msg);
          if (msg.subtype === 'success') resultText = msg.result;
          else throw this.normalizeError(new Error(`Claude ended with "${msg.subtype}"`), msg.subtype);
          break;
        }
        default:
          // user/system/etc. — ignored; text arrives via stream_event.
          break;
      }
    }
    return resultText;
  }

  async respond(text: string, onDelta: (delta: string) => void): Promise<string> {
    let streamed = '';
    let resultText: string;
    try {
      const iterable = this.opts.queryFn({ prompt: text, options: this.buildOptions() });
      resultText = await this.consume(iterable, {
        onDelta: (d) => {
          streamed += d;
          onDelta(d);
        },
      });
    } catch (err) {
      throw this.normalizeError(err);
    }
    // The streamed text is what the user watched appear; prefer it. Fall back to
    // the result string if partial streaming produced nothing (e.g. a terse turn).
    return streamed.length > 0 ? streamed : resultText;
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
    },
    signal: AbortSignal,
  ): Promise<void> {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal.addEventListener('abort', onAbort, { once: true });

    const options: Options = { ...this.buildOptions(), abortController: abort };
    try {
      const resultText = await this.consume(this.opts.queryFn({ prompt, options }), {
        onDelta: events.onDelta,
        onToolUse: events.onToolUse,
      });
      if (!signal.aborted) events.onDone(resultText || 'Done.');
    } catch (err) {
      if (!signal.aborted) events.onError(this.normalizeError(err));
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Reset conversation continuity (start a fresh Claude session next message). */
  resetSession(): void {
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
