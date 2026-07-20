import { describe, it, expect, vi } from 'vitest';
import { mintEphemeralKey, type FetchLike } from './RealtimeKeys.js';

function okResponse(json: unknown): ReturnType<FetchLike> {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(json),
    json: async () => json,
  });
}

describe('mintEphemeralKey', () => {
  it('posts to the client_secrets endpoint with bearer auth + model', async () => {
    const fetchFn = vi.fn<FetchLike>(() => okResponse({ value: 'ek_abc' }));
    const key = await mintEphemeralKey('sk-real', 'gpt-realtime-mini', fetchFn);

    expect(key).toBe('ek_abc');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain('/v1/realtime/client_secrets');
    expect(init.headers.Authorization).toBe('Bearer sk-real');
    expect(JSON.parse(init.body)).toEqual({
      session: { type: 'realtime', model: 'gpt-realtime-mini' },
    });
  });

  it('accepts the legacy client_secret.value shape', async () => {
    const fetchFn = vi.fn<FetchLike>(() => okResponse({ client_secret: { value: 'ek_legacy' } }));
    expect(await mintEphemeralKey('sk', 'm', fetchFn)).toBe('ek_legacy');
  });

  it('throws with no API key', async () => {
    await expect(mintEphemeralKey('', 'm', vi.fn())).rejects.toThrow(/No OpenAI API key/);
  });

  it('throws on a non-ok response with status + body', async () => {
    const fetchFn = vi.fn<FetchLike>(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        text: async () => 'bad key',
        json: async () => ({}),
      }),
    );
    await expect(mintEphemeralKey('sk', 'm', fetchFn)).rejects.toThrow(/401 bad key/);
  });

  it('throws when the response has no key', async () => {
    const fetchFn = vi.fn<FetchLike>(() => okResponse({ nope: true }));
    await expect(mintEphemeralKey('sk', 'm', fetchFn)).rejects.toThrow(/did not contain a key/);
  });
});
