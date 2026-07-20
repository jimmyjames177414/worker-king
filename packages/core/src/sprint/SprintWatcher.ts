/**
 * SprintWatcher — subscribes to Sprint's SSE event stream and broadcasts
 * proactive.notify when diffs arrive (new items assigned, guard trips).
 *
 * WorkerKing is the active subscriber; Sprint stays a passive data source.
 * Topologically clean: Windows daemon → WSL2 Sprint at port 5757, the same
 * direction as the get_standup_state tool (already working).
 *
 * Reconnects with exponential backoff when Sprint is not running.
 */

import type { ProactiveNotice } from '../claude/tools.js';
import type { Logger } from '../util/logger.js';

export class SprintWatcher {
  private controller: AbortController | null = null;
  private stopped = false;
  private retryMs = 5_000;
  private readonly maxRetryMs = 60_000;

  constructor(
    private readonly notify: (n: ProactiveNotice) => void,
    private readonly logger?: Pick<Logger, 'info' | 'warn'>,
  ) {}

  start(): void {
    this.stopped = false;
    this.scheduleConnect(0);
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    this.controller = null;
  }

  private scheduleConnect(delayMs: number): void {
    if (this.stopped) return;
    setTimeout(() => void this.connect(), delayMs);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.controller = new AbortController();
    try {
      const res = await fetch('http://127.0.0.1:5757/events', {
        headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
        signal: this.controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      this.retryMs = 5_000; // reset backoff on success
      this.logger?.info('SprintWatcher connected', {});
      await this.readStream(res.body);
    } catch (err: unknown) {
      if (this.stopped) return;
      const msg = err instanceof Error ? err.message : String(err);
      // AbortError is expected on stop(); don't retry.
      if (err instanceof Error && err.name === 'AbortError') return;
      this.logger?.warn('SprintWatcher disconnected', { error: msg, retryMs: this.retryMs });
      this.scheduleConnect(this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (!this.stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE events are separated by blank lines (\n\n).
        const events = buf.split('\n\n');
        buf = events.pop() ?? '';
        for (const chunk of events) this.handleChunk(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    // Server closed the stream normally — reconnect.
    if (!this.stopped) this.scheduleConnect(this.retryMs);
  }

  private handleChunk(chunk: string): void {
    let eventName = '';
    let dataStr = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataStr = line.slice(5).trim();
    }
    if (eventName !== 'diff' || !dataStr) return;
    let diff: DiffEvent;
    try {
      diff = JSON.parse(dataStr) as DiffEvent;
    } catch {
      return;
    }
    this.onDiff(diff);
  }

  private onDiff(diff: DiffEvent): void {
    if (diff.guardTripped) {
      this.notify({
        text: 'Sprint data guard tripped — snapshot not updated. Item count dropped unexpectedly.',
        level: 'warn',
        speak: false,
        source: 'sprint',
      });
      return;
    }
    const parts: string[] = [];
    if (diff.new?.length)
      parts.push(`${diff.new.length} new task${diff.new.length > 1 ? 's' : ''} assigned`);
    if (diff.closed?.length) parts.push(`${diff.closed.length} closed`);
    if (diff.reassigned?.length) parts.push(`${diff.reassigned.length} reassigned`);
    if (!parts.length) return;
    this.notify({ text: parts.join(', '), level: 'info', speak: true, source: 'sprint' });
  }
}

interface DiffEvent {
  guardTripped?: boolean;
  new?: Array<{ id: number; title: string }>;
  closed?: Array<{ id: number; title: string }>;
  reassigned?: Array<{ id: number; title: string }>;
}
