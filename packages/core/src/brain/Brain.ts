/**
 * Brain — the pluggable text-response engine behind the chat path.
 *
 * Phase 0 ships EchoBrain. Phase 1 replaces it with ClaudeBackend (the Claude
 * Agent SDK wrapper) implementing the same interface, so the Supervisor and WS
 * plumbing don't change when the real brain arrives.
 */
export interface Brain {
  readonly id: string;
  /**
   * Produce a response to `text`, streaming deltas via `onDelta`.
   * Resolves with the full final text.
   */
  respond(text: string, onDelta: (delta: string) => void): Promise<string>;
}

/**
 * Phase 0 brain: echoes the user's message back in a few streamed chunks so the
 * end-to-end streaming path (renderer -> WS -> daemon -> WS -> renderer) is
 * exercised without any AI.
 */
export class EchoBrain implements Brain {
  readonly id = 'echo';

  async respond(text: string, onDelta: (delta: string) => void): Promise<string> {
    const reply = `You said: ${text}`;
    // Stream word-by-word to mimic token deltas.
    const words = reply.split(' ');
    let acc = '';
    for (let i = 0; i < words.length; i++) {
      const chunk = (i === 0 ? '' : ' ') + words[i];
      acc += chunk;
      onDelta(chunk);
    }
    return acc;
  }
}
