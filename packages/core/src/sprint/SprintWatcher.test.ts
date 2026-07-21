import { describe, it, expect, vi, afterEach } from 'vitest';
import { SprintWatcher } from './SprintWatcher.js';
import type { ProactiveNotice } from '../claude/tools.js';

afterEach(() => vi.restoreAllMocks());

/** Build a minimal ReadableStream that emits SSE chunks then closes. */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i < chunks.length) ctrl.enqueue(enc.encode(chunks[i++]));
      else ctrl.close();
    },
  });
}

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeFetch(body: ReadableStream<Uint8Array> | null, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: status < 400,
    status,
    body,
  } as unknown as Response);
}

describe('SprintWatcher', () => {
  it('calls notify with info on new tasks assigned', async () => {
    const notices: ProactiveNotice[] = [];
    const stream = sseStream([sseEvent('diff', { new: [{ id: 1, title: 'Task A' }] })]);
    makeFetch(stream);

    const watcher = new SprintWatcher((n) => notices.push(n));
    watcher.start();
    await new Promise((r) => setTimeout(r, 20));
    watcher.stop();

    expect(notices).toHaveLength(1);
    expect(notices[0].level).toBe('info');
    expect(notices[0].speak).toBe(true);
    expect(notices[0].text).toContain('1 new task');
    expect(notices[0].source).toBe('sprint');
  });

  it('calls notify with warn and speak:false on guardTripped', async () => {
    const notices: ProactiveNotice[] = [];
    const stream = sseStream([sseEvent('diff', { guardTripped: true })]);
    makeFetch(stream);

    const watcher = new SprintWatcher((n) => notices.push(n));
    watcher.start();
    await new Promise((r) => setTimeout(r, 20));
    watcher.stop();

    expect(notices).toHaveLength(1);
    expect(notices[0].level).toBe('warn');
    expect(notices[0].speak).toBe(false);
  });

  it('ignores diff events with no actionable changes', async () => {
    const notices: ProactiveNotice[] = [];
    const stream = sseStream([sseEvent('diff', { closed: [] }), sseEvent('diff', {})]);
    makeFetch(stream);

    const watcher = new SprintWatcher((n) => notices.push(n));
    watcher.start();
    await new Promise((r) => setTimeout(r, 20));
    watcher.stop();

    expect(notices).toHaveLength(0);
  });

  it('ignores non-diff SSE events', async () => {
    const notices: ProactiveNotice[] = [];
    const stream = sseStream([sseEvent('state', { foo: 'bar' }), sseEvent('refresh', {})]);
    makeFetch(stream);

    const watcher = new SprintWatcher((n) => notices.push(n));
    watcher.start();
    await new Promise((r) => setTimeout(r, 20));
    watcher.stop();

    expect(notices).toHaveLength(0);
  });

  it('summarises closed and reassigned in the same notify', async () => {
    const notices: ProactiveNotice[] = [];
    const stream = sseStream([
      sseEvent('diff', {
        closed: [{ id: 1, title: 'X' }],
        reassigned: [
          { id: 2, title: 'Y' },
          { id: 3, title: 'Z' },
        ],
      }),
    ]);
    makeFetch(stream);

    const watcher = new SprintWatcher((n) => notices.push(n));
    watcher.start();
    await new Promise((r) => setTimeout(r, 20));
    watcher.stop();

    expect(notices).toHaveLength(1);
    expect(notices[0].text).toContain('1 closed');
    expect(notices[0].text).toContain('2 reassigned');
  });

  it('does not reconnect after stop()', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const watcher = new SprintWatcher(() => {});
    watcher.start();
    await new Promise((r) => setTimeout(r, 10));
    watcher.stop();
    const callsAtStop = spy.mock.calls.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(spy.mock.calls.length).toBe(callsAtStop); // no further calls after stop
  });

  it('emits plural text for multiple new tasks', async () => {
    const notices: ProactiveNotice[] = [];
    const stream = sseStream([
      sseEvent('diff', {
        new: [
          { id: 1, title: 'A' },
          { id: 2, title: 'B' },
        ],
      }),
    ]);
    makeFetch(stream);

    const watcher = new SprintWatcher((n) => notices.push(n));
    watcher.start();
    await new Promise((r) => setTimeout(r, 20));
    watcher.stop();

    expect(notices[0].text).toContain('2 new tasks');
  });
});
