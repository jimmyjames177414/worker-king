import type { VoiceProvider } from '@workerking/voice-providers';
import { isKind, SentenceChunker, type JsonValue } from '@workerking/shared';
import type { WsClient } from '../shared/wsClient.js';

/** Monotonic clock for latency timing (N7). */
const now = (): number => performance.now();

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
  private providerId: 'gpt-realtime' | 'local-cascade' = 'gpt-realtime';
  /** Monotonic id of the current voice turn; bumping it invalidates in-flight replies (N2). */
  private turnEpoch = 0;
  /** True while a cascade reply is streaming/being spoken (barge-in target). */
  private turnActive = false;
  /** Serializes sentence playback so streamed sentences don't overlap (N3). */
  private speakChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly ws: WsClient,
    private readonly bridge: VoiceBridge,
    private readonly getPersona: () => string,
  ) {
    // Keep the model + active provider in sync with daemon config.
    this.ws.on('config.changed', (env) => {
      if (env.payload.key === 'openaiModel' && typeof env.payload.value === 'string') {
        this.model = env.payload.value;
      }
      if (env.payload.key === 'voiceProvider' && typeof env.payload.value === 'string') {
        this.providerId = env.payload.value === 'local-cascade' ? 'local-cascade' : 'gpt-realtime';
      }
    });
    this.ws.send('config.get', { key: 'openaiModel' });
    this.ws.send('config.get', { key: 'voiceProvider' });

    // Spoken progress + final results from delegated tasks. Routed through the
    // same serialized speak chain as streamed reply sentences — injecting the
    // provider directly here would overlap a sentence that is already playing.
    this.ws.on('task.progress', (env) => {
      this.enqueueSpeech(env.payload.progress.text);
    });
    this.ws.on('task.done', (env) => {
      const summary = env.payload.task.result?.summary;
      if (summary) this.enqueueSpeech(summary);
    });
    this.ws.on('task.error', (env) => {
      this.enqueueSpeech(`That task ran into a problem: ${env.payload.error}`);
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

  /** Bumped by stop(); a start still in flight when it changes must tear down. */
  private startEpoch = 0;
  /** The in-flight start(), so stop() can wait for it instead of racing it. */
  private startPromise?: Promise<void>;

  async toggle(): Promise<void> {
    if (this.active) await this.stop();
    else await this.start();
  }

  /** Speak text aloud if a voice session is active (proactive notices, explain replies). */
  async speak(text: string): Promise<void> {
    this.enqueueSpeech(text);
    await this.speakChain;
  }

  /**
   * Append out-of-band speech (task progress, proactive notices) to the same
   * serialized chain as streamed reply sentences — the single queue is what
   * keeps two utterances from ever playing over each other.
   */
  private enqueueSpeech(text: string): void {
    this.speakChain = this.speakChain
      .then(async () => {
        await this.provider?.injectAssistantContext(text, { speakNow: true });
      })
      .catch(() => {});
  }

  private async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    const myStart = ++this.startEpoch;
    this.startPromise = this.doStart(myStart);
    await this.startPromise;
  }

  private async doStart(myStart: number): Promise<void> {
    const cascade = this.providerId === 'local-cascade';
    const { GptRealtimeProvider, createLocalCascadeProvider, createRealtimeSessionFactory } =
      await import('@workerking/voice-providers');
    // stop() during the dynamic import: bail before creating anything live.
    if (myStart !== this.startEpoch) return;
    const provider: VoiceProvider = cascade
      ? createLocalCascadeProvider()
      : new GptRealtimeProvider({
          model: this.model,
          mintKey: () => this.bridge.mintRealtimeKey(),
          createSession: createRealtimeSessionFactory,
        });
    this.provider = provider;

    try {
      await provider.start({
        systemPrompt: this.getPersona(),
        tools: cascade ? [] : this.supervisorTools(),
        delegate: {
          onToolCall: async (name: string, args: JsonValue): Promise<JsonValue> => {
            const reply = await this.ws.request('voice.tool_call', { name, args });
            if (isKind(reply, 'voice.tool_result')) return reply.payload.result as JsonValue;
            return {};
          },
          onUserTranscript: (text, final) => {
            this.ws.send('voice.transcript', { role: 'user', text, final });
            // Cascade mode: route the transcript to the Claude brain + speak the
            // reply (GPT Realtime speaks on its own, so no routing there).
            if (cascade && final && text.trim()) void this.handleCascadeTurn(text);
          },
          onAssistantTranscript: (text, final) => {
            // Cascade replies already reach the chat via chat.assistant_delta/
            // done; re-emitting each spoken sentence here would render (and
            // persist) every answer twice — once whole, once per sentence.
            if (!cascade) this.ws.send('voice.transcript', { role: 'assistant', text, final });
          },
          onStateChange: (state) => this.ws.send('voice.state', { state }),
          onSpeechStart: () => {
            // Barge-in: invalidate any in-flight/queued reply so a now-stale
            // response is never spoken over the user (N2).
            if (this.turnActive) this.turnEpoch++;
          },
          onAudioLevel: (level) => this.ws.send('voice.audio_level', { level }),
          onError: (err) => {
            this.ws.send('voice.state', { state: 'error' });
            console.error('[voice]', err);
          },
        },
      });
      // stop() while the session was coming up: it found no provider to stop,
      // so tear down the one we just started — otherwise the mic stays hot
      // while the avatar shows idle.
      if (myStart !== this.startEpoch) {
        await provider.stop();
        if (this.provider === provider) this.provider = undefined;
      }
    } catch (err) {
      this.active = false;
      if (this.provider === provider) this.provider = undefined;
      this.ws.send('voice.state', { state: 'error' });
      console.error('[voice] failed to start', err);
    }
  }

  /**
   * Cascade mode: route a transcript to the daemon Claude brain and speak the
   * reply *sentence-by-sentence as it streams* (N3), so speech starts on the
   * first sentence instead of after the whole reply — turning turn latency from
   * sum(STT+LLM+TTS) toward max(...). Guarded by a turn epoch so a barge-in or a
   * newer turn drops the stale reply (N2), and timed end-to-end (N7).
   */
  private async handleCascadeTurn(text: string): Promise<void> {
    const myTurn = ++this.turnEpoch;
    this.turnActive = true;
    const messageId = crypto.randomUUID();
    const chunker = new SentenceChunker();
    const t0 = now();
    let firstDeltaAt = 0;
    let spokenAny = false;

    const speak = (sentence: string): void => {
      spokenAny = true;
      this.speakChain = this.speakChain
        .then(async () => {
          if (myTurn !== this.turnEpoch) return; // superseded by a newer turn / barge-in
          await this.provider?.injectAssistantContext(sentence, { speakNow: true });
        })
        .catch(() => {});
    };

    // Speak each sentence the moment its boundary streams in.
    const offDelta = this.ws.on('chat.assistant_delta', (env) => {
      if (env.payload.messageId !== messageId || myTurn !== this.turnEpoch) return;
      if (!firstDeltaAt) firstDeltaAt = now();
      for (const sentence of chunker.push(env.payload.delta)) speak(sentence);
    });

    try {
      const full = await this.awaitChatReply(text, messageId);
      if (myTurn !== this.turnEpoch) return; // barged-in / superseded during generation
      for (const tail of chunker.flush()) speak(tail);
      // If the daemon didn't stream deltas, fall back to the whole reply.
      if (!spokenAny && full) speak(full);
      await this.speakChain;
      this.logTurnLatency(t0, firstDeltaAt);
    } finally {
      offDelta();
      if (myTurn === this.turnEpoch) this.turnActive = false;
    }
  }

  /** Emit a structured end-of-speech-to-first-audio latency line (N7). */
  private logTurnLatency(t0: number, firstDeltaAt: number): void {
    const ttfb = firstDeltaAt ? Math.round(firstDeltaAt - t0) : -1;
    const total = Math.round(now() - t0);
    // Renderer console is forwarded to main stderr / the log runner.
    console.log(`[voice] turn latency: first_token=${ttfb}ms total=${total}ms`);
  }

  /** Send chat.user_message and resolve with the full reply (matched by messageId). */
  private awaitChatReply(text: string, messageId: string, timeoutMs = 60000): Promise<string> {
    return new Promise((resolve) => {
      const off = this.ws.on('chat.assistant_done', (env) => {
        if (env.payload.messageId === messageId) {
          clearTimeout(timer);
          off();
          resolve(env.payload.text);
        }
      });
      const timer = setTimeout(() => {
        off();
        resolve('');
      }, timeoutMs);
      this.ws.send('chat.user_message', { text, messageId });
    });
  }

  async stop(): Promise<void> {
    // Invalidate any start still in flight, then wait for it to settle so the
    // provider reference (if it got assigned) is the one we stop — a bare stop
    // during start used to leave the just-created session live and orphaned.
    this.startEpoch++;
    this.active = false;
    await this.startPromise?.catch(() => {});
    await this.provider?.stop();
    this.provider = undefined;
    this.ws.send('voice.state', { state: 'idle' });
  }
}
