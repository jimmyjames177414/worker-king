import { describe, it, expect, vi, afterEach } from 'vitest';
import { SprintContext } from './SprintContext.js';

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

const FULL_STATE = {
  sprint: { name: 'Sprint 42', finishDate: new Date(Date.now() + 2 * 86_400_000).toISOString() },
  focus: [
    { ref: 'WI-1', label: 'Fix auth bug' },
    { ref: 'WI-2', label: 'Write tests' },
  ],
  prs: { created: [{}], reviewing: [{}, {}] },
  lastFetch: new Date(Date.now() - 5 * 60_000).toISOString(),
  lastFetchOk: true,
};

describe('SprintContext.sprintBlock', () => {
  it('returns empty string before first fetch', () => {
    const ctx = new SprintContext();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response);
    expect(ctx.sprintBlock()).toBe('');
  });

  it('returns built block after successful refresh', async () => {
    mockFetch(200, FULL_STATE);
    const ctx = new SprintContext();
    await ctx.refresh();
    const block = ctx.sprintBlock();
    expect(block).toContain('Sprint 42');
    expect(block).toContain('2 day');
    expect(block).toContain('Fix auth bug');
    expect(block).toContain('1 open by you');
    expect(block).toContain('2 awaiting your review');
    expect(block).toContain('5m ago');
  });

  it('returns empty string when Sprint is not running', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const ctx = new SprintContext();
    await ctx.refresh();
    expect(ctx.sprintBlock()).toBe('');
  });

  it('returns cached value within TTL without re-fetching', async () => {
    const spy = mockFetch(200, FULL_STATE);
    const ctx = new SprintContext({ ttlMs: 60_000 });
    await ctx.refresh();
    ctx.sprintBlock(); // within TTL
    ctx.sprintBlock(); // still within TTL
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('triggers background refresh when cache is stale', async () => {
    const spy = mockFetch(200, FULL_STATE);
    const ctx = new SprintContext({ ttlMs: 0 }); // TTL = 0 → always stale
    await ctx.refresh();
    spy.mockClear();
    ctx.sprintBlock(); // stale → fires background refresh
    await Promise.resolve(); // flush microtasks
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('applies TTL on HTTP error to prevent retry spam', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
    } as Response);
    const ctx = new SprintContext({ ttlMs: 60_000 });
    await ctx.refresh();
    spy.mockClear();
    ctx.sprintBlock(); // cached null, but fetchedAt is set → should NOT re-fetch
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('applies TTL on network failure to prevent retry spam', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const ctx = new SprintContext({ ttlMs: 60_000 });
    await ctx.refresh();
    spy.mockClear();
    ctx.sprintBlock(); // same — should NOT re-fetch within TTL
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(0);
  });

  it('handles state with no optional fields', async () => {
    mockFetch(200, {});
    const ctx = new SprintContext();
    await ctx.refresh();
    // Should produce at minimum the header line without crashing
    const block = ctx.sprintBlock();
    expect(block).toContain('Sprint standup context');
  });

  it('shares one in-flight refresh between concurrent callers', async () => {
    const spy = mockFetch(200, FULL_STATE);
    const ctx = new SprintContext();
    await Promise.all([ctx.refresh(), ctx.refresh(), ctx.refresh()]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('truncates focus list beyond 3 items', async () => {
    mockFetch(200, {
      ...FULL_STATE,
      focus: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }, { label: 'E' }],
    });
    const ctx = new SprintContext();
    await ctx.refresh();
    const block = ctx.sprintBlock();
    expect(block).toContain('… and 2 more');
    // The 4th/5th items are dropped. Match the rendered list-row form ("    - D")
    // rather than a bare 'D', which would also match the 'D' in "Last ADO fetch".
    expect(block).not.toContain('- D');
    expect(block).not.toContain('- E');
  });
});

/**
 * The standup fetch. `POST /api/refresh` is fire-and-forget (202) so completion
 * is detected by `staleness.lastFetch` moving — these drive that state machine
 * with a scripted fetch rather than a real dashboard.
 */
describe('SprintContext.runMorningFetch', () => {
  const BEFORE = { ...FULL_STATE, staleness: { lastFetch: 'T1', lastFetchOk: true } };
  const AFTER = { ...FULL_STATE, staleness: { lastFetch: 'T2', lastFetchOk: true } };

  /** Serve /api/state from a queue of bodies; /api/refresh returns `refreshStatus`. */
  function scriptedFetch(states: unknown[], refreshStatus = 202) {
    const calls: string[] = [];
    const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/api/refresh')) {
        return {
          ok: refreshStatus >= 200 && refreshStatus < 300,
          status: refreshStatus,
        } as Response;
      }
      const body = states.length > 1 ? states.shift() : states[0];
      return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
    });
    return { impl: impl as unknown as typeof globalThis.fetch, calls };
  }

  function ctxWith(impl: typeof globalThis.fetch) {
    return new SprintContext({
      fetchImpl: impl,
      pollMs: 0,
      fetchTimeoutMs: 1_000,
      sleep: () => Promise.resolve(),
    });
  }

  it('posts the refresh and waits for lastFetch to move', async () => {
    const { impl, calls } = scriptedFetch([BEFORE, AFTER]);
    const result = await ctxWith(impl).runMorningFetch();
    expect(result.status).toBe('refreshed');
    expect(result.lastFetch).toBe('T2');
    expect(calls).toContain('POST http://127.0.0.1:5757/api/refresh');
  });

  it('treats a 409 as "someone else is already fetching" and waits for that run', async () => {
    const { impl } = scriptedFetch([BEFORE, AFTER], 409);
    const result = await ctxWith(impl).runMorningFetch();
    expect(result.status).toBe('refreshed');
  });

  it('reports stale when the fetch never lands inside the budget', async () => {
    const { impl } = scriptedFetch([BEFORE]); // lastFetch never moves
    const result = await ctxWith(impl).runMorningFetch();
    expect(result.status).toBe('stale');
  });

  it('reports unreachable when the dashboard is down', async () => {
    const impl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await ctxWith(impl as unknown as typeof globalThis.fetch).runMorningFetch();
    expect(result.status).toBe('unreachable');
  });

  it('never runs two fetches at once — a second "morning" joins the first', async () => {
    const { impl, calls } = scriptedFetch([BEFORE, AFTER]);
    const ctx = ctxWith(impl);
    const [a, b] = await Promise.all([ctx.runMorningFetch(), ctx.runMorningFetch()]);
    expect(a).toEqual(b);
    expect(calls.filter((c) => c.includes('/api/refresh'))).toHaveLength(1);
  });

  it('rebuilds the cached block from post-fetch data', async () => {
    const { impl } = scriptedFetch([BEFORE, { ...AFTER, sprint: { name: 'Sprint 43' } }]);
    const ctx = ctxWith(impl);
    await ctx.runMorningFetch();
    expect(ctx.sprintBlock()).toContain('Sprint 43');
  });
});
