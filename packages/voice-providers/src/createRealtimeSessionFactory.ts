import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents-realtime';
import type { JsonValue } from '@workerking/shared';
import type { RealtimeSessionLike, SessionFactory } from './GptRealtimeProvider.js';

/**
 * The real `SessionFactory` — builds a `@openai/agents-realtime` RealtimeAgent +
 * RealtimeSession (WebRTC by default in the renderer). Kept separate from
 * GptRealtimeProvider so the provider stays SDK-free and unit-testable; the
 * overlay renderer imports this factory and passes it to the provider.
 */
export const createRealtimeSessionFactory: SessionFactory = (cfg): RealtimeSessionLike => {
  const tools = cfg.tools.map((spec) =>
    tool({
      name: spec.name,
      description: spec.description,
      // Forward the real per-tool JSON Schema so the realtime model sees actual
      // argument shapes (was a permissive empty-object schema, so the model
      // could call e.g. delegate_to_worker with no `task`).
      parameters: {
        type: 'object' as const,
        properties: (spec.parameters.properties as Record<string, unknown>) ?? {},
        required: (spec.parameters.required as string[]) ?? [],
        additionalProperties: true as const,
      },
      strict: false,
      execute: async (args: unknown) => {
        const result = await cfg.onToolCall(spec.name, (args ?? {}) as JsonValue);
        return typeof result === 'string' ? result : JSON.stringify(result);
      },
    }),
  );

  const agent = new RealtimeAgent({
    name: 'WorkerKing',
    instructions: cfg.systemPrompt,
    tools,
  });

  const session = new RealtimeSession(agent, {
    model: cfg.model,
    // Without an input-transcription model the server never transcribes the
    // user's speech — user captions/history would be empty. Also the source of
    // the user partial-transcript events the provider streams to captions.
    config: { audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe' } } } },
  });
  // The real RealtimeSession exposes `.transport` (requestResponse /
  // updateSessionConfig / raw events) — the provider uses it for out-of-band
  // speech injection, turn tracking, and drop detection.
  return session as unknown as RealtimeSessionLike;
};
