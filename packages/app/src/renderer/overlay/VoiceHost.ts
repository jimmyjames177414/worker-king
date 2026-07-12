import {
  GptRealtimeProvider,
  createRealtimeSessionFactory,
  type VoiceProvider,
} from '@workerking/voice-providers';
import type { JsonValue } from '@workerking/shared';
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

    this.bridge.onPushToTalk(() => void this.toggle());
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
        tools: [], // voice delegation tools arrive in Phase 3
        delegate: {
          onToolCall: async (name: string, args: JsonValue): Promise<JsonValue> => {
            this.ws.send('voice.tool_call', { name, args });
            return {}; // Phase 3 correlates the daemon's voice.tool_result reply
          },
          onUserTranscript: (text, final) =>
            this.ws.send('voice.transcript', { role: 'user', text, final }),
          onAssistantTranscript: (text, final) =>
            this.ws.send('voice.transcript', { role: 'assistant', text, final }),
          onStateChange: (state) => this.ws.send('voice.state', { state }),
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
