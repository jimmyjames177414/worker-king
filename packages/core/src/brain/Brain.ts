import type { TaskRunner, TaskRunEvents } from '../tasks/TaskManager.js';

/**
 * Brain — the pluggable engine behind both the chat path (`respond`) and the
 * voice-delegation path (`run`, from TaskRunner).
 *
 * Phase 0 ships EchoBrain. Phase 1+ uses ClaudeBackend (the Claude Agent SDK
 * wrapper), so the Supervisor, TaskManager, and WS plumbing don't change when the
 * real brain arrives.
 */
export interface Brain extends TaskRunner {
  readonly id: string;
  /**
   * Produce a response to `text`, streaming deltas via `onDelta`.
   * Resolves with the full final text.
   */
  respond(text: string, onDelta: (delta: string) => void): Promise<string>;
}

/**
 * DeferredBrain — a placeholder that lets the daemon come up instantly while the
 * real brain (Claude) is still being probed/warmed in the background.
 *
 * `respond` calls made before a brain is installed wait for it (bounded by the
 * caller); once `set()` is called they delegate to the real brain. This keeps
 * daemon boot non-blocking: the WS server is READY immediately and the first
 * chat message simply waits a beat for Claude to warm, instead of the whole
 * process hanging on `startup()`.
 */
export class DeferredBrain implements Brain {
  readonly id = 'deferred';
  private brain?: Brain;
  private waiters: Array<(b: Brain) => void> = [];

  set(brain: Brain): void {
    this.brain = brain;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w(brain);
  }

  isReady(): boolean {
    return this.brain !== undefined;
  }

  private waitForBrain(): Promise<Brain> {
    if (this.brain) return Promise.resolve(this.brain);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async respond(text: string, onDelta: (delta: string) => void): Promise<string> {
    const brain = await this.waitForBrain();
    return brain.respond(text, onDelta);
  }

  async run(prompt: string, events: TaskRunEvents, signal: AbortSignal): Promise<void> {
    const brain = await this.waitForBrain();
    return brain.run(prompt, events, signal);
  }
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

  async run(prompt: string, events: TaskRunEvents, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    events.onDelta(prompt);
    events.onDone(`Echo task complete: ${prompt}`);
  }
}
