import type { ToolPermissionMode } from '@workerking/shared';

/**
 * Tool-permission policy (N1).
 *
 * WorkerKing drives the full Claude Code toolset (Bash/Write/Edit/…), and voice
 * is an *unauthenticated* interface — anyone within earshot can speak a turn. So
 * the mutating tools must not run unchecked. This module decides, per tool call,
 * whether to allow, deny, or ask — mirroring cybara's policy-filtered tool subset
 * and cicero's fail-closed confirmation gates.
 *
 * Kept pure (no SDK, no WS) so it is unit-testable; `main.ts` wires the confirmer
 * to a real UI round-trip.
 */

/** Built-in Claude Code tools that can modify the machine (files or shell). */
export const MUTATING_TOOLS = new Set([
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'KillShell',
]);

/** True for a tool that can change files or run commands. */
export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

/** Asks a UI client to approve a destructive tool call (fail-closed on no answer). */
export interface ToolConfirmer {
  confirm(req: { tool: string; summary: string }): Promise<boolean>;
}

/** The subset of the SDK's PermissionResult we ever return. */
export type ToolDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string };

export interface ToolPolicyOptions {
  /** Read live from config so a settings change applies without a restart. */
  mode: () => ToolPermissionMode;
  /** Confirmation channel for `gated` mode; absent → gated denies (fail-closed). */
  confirmer?: ToolConfirmer;
  /** Build the human-readable confirmation summary for a call. */
  summarize?: (tool: string, input: Record<string, unknown>) => string;
}

/** Default one-line summary of a tool call for the confirmation prompt. */
export function summarizeToolCall(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash' && typeof input.command === 'string') {
    return `Run a shell command: ${truncate(input.command, 160)}`;
  }
  const path = input.file_path ?? input.path ?? input.notebook_path;
  if (typeof path === 'string') return `${tool} ${path}`;
  return `Use the ${tool} tool`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Build the per-call decision function.
 * - `auto`     → allow everything (the SDK default; no WorkerKing gate).
 * - `readonly` → allow read-only tools, deny mutating ones outright.
 * - `gated`    → allow read-only tools; mutating ones require confirmation, and
 *   deny fail-closed if no confirmer is wired or the user declines.
 *
 * Non-mutating tools (Read/Grep/Glob, WorkerKing's own mcp tools, …) always pass.
 */
export function createToolPolicy(opts: ToolPolicyOptions) {
  const summarize = opts.summarize ?? summarizeToolCall;
  return async function decide(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ToolDecision> {
    const mode = opts.mode();
    if (mode === 'auto') return { behavior: 'allow' };
    if (!isMutatingTool(toolName)) return { behavior: 'allow' };

    if (mode === 'readonly') {
      return {
        behavior: 'deny',
        message:
          `WorkerKing is in read-only mode, so "${toolName}" is blocked. ` +
          'Tell the user they can allow edits in settings (toolPermissionMode).',
      };
    }

    // gated: require an explicit, fail-closed approval.
    if (!opts.confirmer) {
      return {
        behavior: 'deny',
        message:
          `"${toolName}" needs the user's confirmation, but no approval channel is connected. ` +
          'Denied (fail-closed).',
      };
    }
    const approved = await opts.confirmer.confirm({ tool: toolName, summary: summarize(toolName, input) });
    return approved
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: `The user declined the "${toolName}" action.` };
  };
}
