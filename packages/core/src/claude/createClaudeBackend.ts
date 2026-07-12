import { query, startup } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeBackend, type ClaudeBackendOptions } from './ClaudeBackend.js';

/**
 * Factory that wires ClaudeBackend to the real SDK `query`. Isolated here so the
 * ClaudeBackend unit (and its tests) never import SDK *values* — only types.
 */
export function createClaudeBackend(
  opts: Omit<ClaudeBackendOptions, 'queryFn'> = {},
): ClaudeBackend {
  return new ClaudeBackend({ queryFn: query, ...opts });
}

export interface ClaudeHealth {
  ok: boolean;
  detail?: string;
}

/**
 * Warm the Claude Code subprocess and confirm it can initialize. Used at daemon
 * boot: on success the first real message has no cold-start penalty; on failure
 * we surface an auth/setup hint instead of letting the daemon look broken.
 *
 * Bounded by `timeoutMs` (via the SDK's own initialize timeout plus a hard race)
 * so a hung spawn can never block daemon startup.
 */
export async function probeClaude(cwd?: string, timeoutMs = 8000): Promise<ClaudeHealth> {
  try {
    const warmPromise = startup({
      initializeTimeoutMs: timeoutMs,
      options: cwd ? { cwd } : {},
    });
    const warm = await withTimeout(warmPromise, timeoutMs + 1000, 'probe timed out');
    // `startup` resolves once the subprocess is initialized and authenticated.
    // Close it immediately; boot spawns the working session lazily on first use.
    warm.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
