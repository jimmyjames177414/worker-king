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
  /** Persona appended to Claude Code's preset system prompt. */
  personaAppend?: string;
  /**
   * Live persona provider (read per message) — lets settings/character-card
   * changes apply without restarting. Takes precedence over `personaAppend`.
   */
  personaProvider?: () => string;
  /** Permission posture for autonomous tool use. Phase 1 keeps the default. */
  permissionMode?: Options['permissionMode'];
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

export class ClaudeBackend implements Brain {
  readonly id = 'claude';
  private sessionId: string | undefined;

  constructor(private readonly opts: ClaudeBackendOptions) {}

  private buildOptions(): Options {
    const append = this.opts.personaProvider?.() ?? this.opts.personaAppend;
    const options: Options = {
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(append ? { append } : {}),
      },
      includePartialMessages: true,
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      ...(this.opts.permissionMode ? { permissionMode: this.opts.permissionMode } : {}),
      ...(this.opts.maxTurns ? { maxTurns: this.opts.maxTurns } : {}),
      ...(this.opts.mcpServers ? { mcpServers: this.opts.mcpServers } : {}),
      ...(this.opts.allowedTools ? { allowedTools: this.opts.allowedTools } : {}),
      ...(this.sessionId ? { resume: this.sessionId } : {}),
    };
    return options;
  }

  async respond(text: string, onDelta: (delta: string) => void): Promise<string> {
    let streamed = '';
    let resultText: string | undefined;

    let iterable: AsyncIterable<SDKMessage>;
    try {
      iterable = this.opts.queryFn({ prompt: text, options: this.buildOptions() });
    } catch (err) {
      throw this.normalizeError(err);
    }

    try {
      for await (const msg of iterable) {
        switch (msg.type) {
          case 'stream_event': {
            const delta = extractTextDelta(msg.event);
            if (delta) {
              streamed += delta;
              onDelta(delta);
            }
            break;
          }
          case 'result': {
            // Persist the session id so the next message continues the thread.
            this.sessionId = msg.session_id;
            if (msg.subtype === 'success') {
              resultText = msg.result;
            } else {
              throw this.normalizeError(
                new Error(`Claude ended with "${msg.subtype}"`),
                msg.subtype,
              );
            }
            break;
          }
          default:
            // assistant/user/system/etc. — ignored; text arrives via stream_event.
            break;
        }
      }
    } catch (err) {
      throw this.normalizeError(err);
    }

    // The streamed text is what the user watched appear; prefer it. Fall back to
    // the result string if partial streaming produced nothing (e.g. a terse turn).
    return streamed.length > 0 ? streamed : (resultText ?? '');
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
    let resultText = '';
    try {
      for await (const msg of this.opts.queryFn({ prompt, options })) {
        switch (msg.type) {
          case 'stream_event': {
            const delta = extractTextDelta(msg.event);
            if (delta) events.onDelta(delta);
            break;
          }
          case 'assistant': {
            for (const name of extractToolUses(msg)) events.onToolUse(name);
            break;
          }
          case 'result': {
            this.sessionId = msg.session_id;
            if (msg.subtype === 'success') resultText = msg.result;
            else events.onError(this.normalizeError(new Error(`Claude ended with "${msg.subtype}"`)));
            break;
          }
          default:
            break;
        }
      }
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

  private normalizeError(err: unknown, subtype?: string): Error {
    const message = err instanceof Error ? err.message : String(err);
    // Heuristics: surface auth/login problems distinctly so the daemon can prompt
    // the user to run `claude login` instead of looking broken.
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
