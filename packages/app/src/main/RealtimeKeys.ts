/**
 * RealtimeKeys — mint short-lived ephemeral client secrets for the OpenAI Realtime
 * API so the renderer can open a WebRTC session without ever seeing the real key.
 *
 * The real API key lives only in Electron main (safeStorage). Main calls this with
 * that key; the renderer receives only the `ek_...` ephemeral secret via IPC.
 *
 * `fetchFn` is injectable so this is unit-testable headless with a mocked fetch.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> }>;

const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';

export async function mintEphemeralKey(
  apiKey: string,
  model: string,
  fetchFn: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<string> {
  if (!apiKey) throw new Error('No OpenAI API key configured (set it in WorkerKing settings).');

  const res = await fetchFn(CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session: { type: 'realtime', model } }),
  });

  if (!res.ok) {
    throw new Error(`Ephemeral key mint failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    value?: string;
    client_secret?: { value?: string };
  };
  // The current endpoint returns { value, expires_at, ... }; older shapes nested
  // it under client_secret. Accept either.
  const value = data.value ?? data.client_secret?.value;
  if (!value) throw new Error('Ephemeral key mint response did not contain a key.');
  return value;
}
