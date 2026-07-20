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

  it('truncates focus list beyond 3 items', async () => {
    mockFetch(200, {
      ...FULL_STATE,
      focus: [
        { label: 'A' },
        { label: 'B' },
        { label: 'C' },
        { label: 'D' },
        { label: 'E' },
      ],
    });
    const ctx = new SprintContext();
    await ctx.refresh();
    const block = ctx.sprintBlock();
    expect(block).toContain('… and 2 more');
    expect(block).not.toContain('D');
  });
});
