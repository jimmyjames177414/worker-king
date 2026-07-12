import {
  GptRealtimeProvider,
  createRealtimeSessionFactory,
  type VoiceProvider,
} from '@workerking/voice-providers';
import { isKind, type JsonValue } from '@workerking/shared';
import type { WsClient } from '../shared/wsClient.js';

/** The overlay preload bridge surface VoiceHost needs. */
interface VoiceBridge {
  mintRealtimeKey(): Promise<string>;
  onPushToTalk(cb: () => void): void;
}

/**
 * VoiceHost — owns the active VoiceProvider in the overlay renderer and bridges it
 * onto the WS bus.
 *
 * Push-to-talk (the global hotkey, delivered from main) toggles the voice session.
 * Provider events are rebroadcast as `voice.state` / `voice.transcript` so the
 * avatar (overlay) and the chat window stay in sync; tool calls are forwarded as
 * `voice.tool_call` (delegation wiring completes in Phase 3).
 */
export class VoiceHost {
  private provider?: VoiceProvider;
  private active = false;
  private model = 'gpt-realtime-mini';

  constructor(
    private readonly ws: WsClient,
    private readonly bridge: VoiceBridge,
    private readonly getPersona: () => string,
  ) {
    // Keep the model in sync with daemon config.
    this.ws.on('config.changed', (env) => {
      if (env.payload.key === 'openaiModel' && typeof env.payload.value === 'string') {
        this.model = env.payload.value;
      }
    });
    this.ws.send('config.get', { key: 'openaiModel' });

    // Spoken progress + final results from delegated tasks (turn-gated inside the
    // provider so they don't collide with the user speaking).
    this.ws.on('task.progress', (env) => {
      void this.provider?.injectAssistantContext(env.payload.progress.text);
    });
    this.ws.on('task.done', (env) => {
      const summary = env.payload.task.result?.summary;
      if (summary) void this.provider?.injectAssistantContext(summary, { speakNow: true });
    });
    this.ws.on('task.error', (env) => {
      void this.provider?.injectAssistantContext(`That task ran into a problem: ${env.payload.error}`, {
        speakNow: true,
      });
    });

    this.bridge.onPushToTalk(() => void this.toggle());
  }

  /** The chat-supervisor tools the thin voice model delegates through. */
  private supervisorTools() {
    return [
      {
        name: 'delegate_to_worker',
        description:
          'Hand a substantive task to the worker (Claude Code). Returns a task_id immediately; ' +
          'progress and the final result are spoken to the user as they arrive. Use for anything ' +
          'beyond small talk. Say a brief filler like "On it" BEFORE calling this.',
        parameters: {
          type: 'object',
          properties: { task: { type: 'string', description: 'What to do, in plain language.' } },
          required: ['task'],
        },
      },
      {
        name: 'check_task_status',
        description: 'Check how a running task is going.',
        parameters: {
          type: 'object',
          properties: { task_id: { type: 'string' } },
          required: ['task_id'],
        },
      },
      {
        name: 'cancel_task',
        description: 'Stop a running task.',
        parameters: {
          type: 'object',
          properties: { task_id: { type: 'string' } },
          required: ['task_id'],
        },
      },
    ];
  }

  async toggle(): Promise<void> {
    if (this.active) await this.stop();
    else await this.start();
  }

  private async start(): Promise<void> {
    this.active = true;
    const provider = new GptRealtimeProvider({
      model: this.model,
      mintKey: () => this.bridge.mintRealtimeKey(),
      createSession: createRealtimeSessionFactory,
    });
    this.provider = provider;

    try {
      await provider.start({
        systemPrompt: this.getPersona(),
        tools: this.supervisorTools(),
        delegate: {
          onToolCall: async (name: string, args: JsonValue): Promise<JsonValue> => {
            // Round-trip to the daemon Supervisor and return its result to the model.
            const reply = await this.ws.request('voice.tool_call', { name, args });
            if (isKind(reply, 'voice.tool_result')) return reply.payload.result as JsonValue;
            return {};
          },
          onUserTranscript: (text, final) =>
            this.ws.send('voice.transcript', { role: 'user', text, final }),
          onAssistantTranscript: (text, final) =>
            this.ws.send('voice.transcript', { role: 'assistant', text, final }),
          onStateChange: (state) => this.ws.send('voice.state', { state }),
          onAudioLevel: (level) => this.ws.send('voice.audio_level', { level }),
          onError: (err) => {
            this.ws.send('voice.state', { state: 'error' });
            console.error('[voice]', err);
          },
        },
      });
    } catch (err) {
      this.active = false;
      this.provider = undefined;
      this.ws.send('voice.state', { state: 'error' });
      console.error('[voice] failed to start', err);
    }
  }

  private async stop(): Promise<void> {
    await this.provider?.stop();
    this.provider = undefined;
    this.active = false;
    this.ws.send('voice.state', { state: 'idle' });
  }
}
