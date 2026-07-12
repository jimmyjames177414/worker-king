import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents-realtime';
import { z } from 'zod';
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
      // Args are validated on our side; accept a permissive object and forward.
      parameters: z.object({}).passthrough(),
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

  const session = new RealtimeSession(agent, { model: cfg.model });
  return session as unknown as RealtimeSessionLike;
};
