import type { VoiceProvider } from '@workerking/voice-providers';
import {
  isKind,
  SentenceChunker,
  type JsonValue,
  type PayloadOf,
  type WsEnvelope,
  type WsMessageKind,
} from '@workerking/shared';
import { describeError } from '../shared/describeError.js';

/** Monotonic clock for latency timing (N7). */
const now = (): number => performance.now();

/** Spoken + captioned when a cascade turn dies (timeout, speak failure). */
const TURN_FAILURE_NOTICE = "Sorry — that didn't go through. Try again.";

/** The overlay preload bridge surface VoiceHost needs. */
interface VoiceBridge {
  mintRealtimeKey(): Promise<string>;
  onPushToTalk(cb: () => void): void;
}

/**
 * The WS-bus surface VoiceHost needs. Structural on purpose: the real WsClient
 * satisfies it unchanged, and tests satisfy it with a tiny fake bus.
 */
export interface VoiceBus {
  on<K extends WsMessageKind>(kind: K, handler: (env: WsEnvelope<K>) => void): () => void;
  send<K extends WsMessageKind>(kind: K, payload: PayloadOf<K>): void;
  request<K extends WsMessageKind>(
    kind: K,
    payload: PayloadOf<K>,
    timeoutMs?: number,
  ): Promise<WsEnvelope>;
}

/** Builds the active provider; injectable so tests can supply a fake. */
export type ProviderFactory = (cfg: {
  cascade: boolean;
  model: string;
  mintKey: () => Promise<string>;
}) => Promise<VoiceProvider>;

/** The real factory: dynamic import keeps the SDK off the overlay's boot path. */
const defaultProviderFactory: ProviderFactory = async ({ cascade, model, mintKey }) => {
  const { GptRealtimeProvider, createLocalCascadeProvider, createRealtimeSessionFactory } =
    await import('@workerking/voice-providers');
  return cascade
    ? createLocalCascadeProvider()
    : new GptRealtimeProvider({
        model,
        mintKey,
        createSession: createRealtimeSessionFactory,
      });
};

/**
 * VoiceHost — owns the active VoiceProvider in the overlay renderer and bridges it
 * onto the WS bus.
 *
 * Push-to-talk (the global hotkey, delivered from main) toggles the voice session.
 * Provider events are rebroadcast as `voice.state` / `voice.transcript` so the
 * avatar (overlay) and the chat window stay in sync; tool calls are forwarded as
 * `voice.tool_call`.
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
  /**
   * Resolves when the most recently queued utterance finishes speaking.
   * Ordering itself lives in the providers now (cascade play chain, GPT
   * one-OOB-per-turn) — injection is immediate so synthesis runs ahead of
   * playback instead of waiting for the previous utterance to finish.
   */
  private lastSpeech: Promise<void> = Promise.resolve();

  constructor(
    private readonly ws: VoiceBus,
    private readonly bridge: VoiceBridge,
    private readonly getPersona: () => string,
    private readonly createProvider: ProviderFactory = defaultProviderFactory,
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

    // Spoken progress + final results from delegated tasks. Progress is
    // rate-limited: without the gate a chatty task produced back-to-back
    // "still working…" utterances. Finals bypass the gate (and cancel any
    // pending progress — the result supersedes it).
    this.ws.on('task.progress', (env) => {
      this.speakProgress(env.payload.progress.text);
    });
    this.ws.on('task.done', (env) => {
      const summary = env.payload.task.result?.summary;
      this.clearPendingProgress();
      if (summary) this.enqueueSpeech(summary);
    });
    this.ws.on('task.error', (env) => {
      this.clearPendingProgress();
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
          properties: {
            task: { type: 'string', description: 'What to do, in plain language.' },
            folder: {
              type: 'string',
              description:
                'Optional repo name or absolute path to run the task in (resolved against the ' +
                'known repo roots). Omit to use the active project.',
            },
          },
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

  /**
   * Auto-stop a live session after this long with no speech from either side —
   * otherwise a wake-word-triggered session (or a forgotten hotkey press)
   * leaves the mic hot indefinitely. Resets on any user/assistant speech
   * activity; a real back-and-forth conversation never trips it.
   */
  private static readonly SILENCE_TIMEOUT_MS = 15_000;
  private silenceTimer?: ReturnType<typeof setTimeout>;

  private armSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(
      () => void this.onSilenceTimeout(),
      VoiceHost.SILENCE_TIMEOUT_MS,
    );
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== undefined) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = undefined;
    }
  }

  private async onSilenceTimeout(): Promise<void> {
    if (!this.active) return;
    this.ws.send('voice.transcript', {
      role: 'assistant',
      text: 'Going idle after a quiet moment — say the wake word or press the hotkey to start again.',
      final: true,
    });
    await this.stop();
  }

  isActive(): boolean {
    return this.active;
  }

  async toggle(): Promise<void> {
    if (this.active) await this.stop();
    else await this.start();
  }

  /**
   * Start only when idle — the wake word uses this so a (possibly spurious)
   * detection during a live session can never stop it.
   */
  async startIfIdle(): Promise<void> {
    if (!this.active) await this.start();
  }

  /** Speak text aloud if a voice session is active (proactive notices, explain replies). */
  async speak(text: string): Promise<void> {
    this.enqueueSpeech(text);
    await this.lastSpeech;
  }

  /**
   * Hand text to the provider to speak. Providers serialize/pipeline playback
   * themselves; failures are logged (never swallowed) and tracked in lastSpeech.
   */
  private enqueueSpeech(text: string): void {
    const p = this.provider?.injectAssistantContext(text, { speakNow: true }) ?? Promise.resolve();
    this.lastSpeech = p.catch((err) => console.error('[voice] speak failed', err));
  }

  /** Min gap between spoken progress updates — one line every few seconds, not a stream. */
  private static readonly PROGRESS_GAP_MS = 6000;
  private lastProgressAt = -Infinity;
  private pendingProgress?: string;
  private progressTimer?: ReturnType<typeof setTimeout>;

  /**
   * Speak a task-progress line, rate-limited to one per PROGRESS_GAP_MS across
   * all tasks (speech is a single channel). Updates arriving inside the gap
   * replace the pending one — when the gap elapses, only the LATEST is spoken,
   * so the user hears fresh status, never a backlog read out back-to-back.
   */
  private speakProgress(text: string): void {
    this.pendingProgress = text;
    if (this.progressTimer !== undefined) return; // a flush is already scheduled
    const wait = Math.max(0, this.lastProgressAt + VoiceHost.PROGRESS_GAP_MS - Date.now());
    if (wait === 0) {
      this.flushProgress();
      return;
    }
    this.progressTimer = setTimeout(() => this.flushProgress(), wait);
  }

  private flushProgress(): void {
    if (this.progressTimer !== undefined) {
      clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
    }
    const text = this.pendingProgress;
    this.pendingProgress = undefined;
    if (!text) return;
    this.lastProgressAt = Date.now();
    this.enqueueSpeech(text);
  }

  /** Drop any queued progress line (a final result/error supersedes it). */
  private clearPendingProgress(): void {
    if (this.progressTimer !== undefined) {
      clearTimeout(this.progressTimer);
      this.progressTimer = undefined;
    }
    this.pendingProgress = undefined;
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
    const provider = await this.createProvider({
      cascade,
      model: this.model,
      mintKey: () => this.bridge.mintRealtimeKey(),
    });
    // stop() during the provider build: bail before starting anything live.
    if (myStart !== this.startEpoch) return;
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
          onStateChange: (state) => {
            this.ws.send('voice.state', { state });
            // The silence clock only runs while genuinely idle-and-listening
            // with nothing in flight: arming it here (rather than on
            // individual speech events) means a slow reply — the assistant is
            // "thinking" for a while, not silent by neglect — can never trip
            // it, no matter how long that state lasts.
            if (state === 'listening') this.armSilenceTimer();
            else this.clearSilenceTimer();
          },
          onSpeechStart: () => {
            // Barge-in: invalidate any in-flight/queued reply so a now-stale
            // response is never spoken over the user (N2).
            if (this.turnActive) this.turnEpoch++;
          },
          onAudioLevel: (level) => this.ws.send('voice.audio_level', { level }),
          onError: (err, info) => {
            console.error(
              '[voice]',
              `${describeError(err)} (fatal=${info?.fatal ?? false})`,
            );
            if (info?.fatal) {
              // The provider's session is dead and auto-recovery failed. A
              // spoken notice is impossible (the audio path is the dead thing),
              // so surface a caption, tear down cleanly, and leave the avatar
              // on alert — the next hotkey press starts fresh.
              this.ws.send('voice.transcript', {
                role: 'assistant',
                text: 'Voice connection lost — press the hotkey to restart.',
                final: true,
              });
              void this.stop().then(() => this.ws.send('voice.state', { state: 'error' }));
              return;
            }
            this.ws.send('voice.state', { state: 'error' });
          },
        },
      });
      // stop() while the session was coming up: it found no provider to stop,
      // so tear down the one we just started — otherwise the mic stays hot
      // while the avatar shows idle.
      if (myStart !== this.startEpoch) {
        await provider.stop();
        if (this.provider === provider) this.provider = undefined;
        return;
      }
      // No explicit arm here: the provider's own initial state transition to
      // 'listening' (already fired by the time provider.start() resolves)
      // reaches onStateChange above and arms it from there.
    } catch (err) {
      this.active = false;
      if (this.provider === provider) this.provider = undefined;
      this.ws.send('voice.state', { state: 'error' });
      console.error('[voice] failed to start', describeError(err));
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
      if (myTurn !== this.turnEpoch) return; // superseded by a newer turn / barge-in
      this.enqueueSpeech(sentence);
    };

    // Speak each sentence the moment its boundary streams in.
    const offDelta = this.ws.on('chat.assistant_delta', (env) => {
      if (env.payload.messageId !== messageId || myTurn !== this.turnEpoch) return;
      if (!firstDeltaAt) firstDeltaAt = now();
      for (const sentence of chunker.push(env.payload.delta)) speak(sentence);
    });

    try {
      const reply = await this.awaitChatReply(text, messageId);
      if (myTurn !== this.turnEpoch) return; // barged-in / superseded during generation
      if (reply.timedOut) {
        // Silence would read as a hang — say so, caption it, flag the avatar.
        console.error(`[voice] chat reply timed out (messageId=${messageId})`);
        this.ws.send('voice.transcript', {
          role: 'assistant',
          text: TURN_FAILURE_NOTICE,
          final: true,
        });
        this.ws.send('voice.state', { state: 'error' });
        this.enqueueSpeech(TURN_FAILURE_NOTICE);
        await this.lastSpeech;
        return;
      }
      for (const tail of chunker.flush()) speak(tail);
      // If the daemon didn't stream deltas, fall back to the whole reply.
      if (!spokenAny && reply.text) speak(reply.text);
      await this.lastSpeech;
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

  /**
   * Send chat.user_message and resolve with the full reply (matched by
   * messageId), or `timedOut: true` — never silently with an empty string, so
   * the caller can tell "no answer" from "empty answer" and say something.
   */
  private awaitChatReply(
    text: string,
    messageId: string,
    timeoutMs = 60000,
  ): Promise<{ text: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const off = this.ws.on('chat.assistant_done', (env) => {
        if (env.payload.messageId === messageId) {
          clearTimeout(timer);
          off();
          resolve({ text: env.payload.text, timedOut: false });
        }
      });
      const timer = setTimeout(() => {
        off();
        resolve({ text: '', timedOut: true });
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
    this.clearPendingProgress();
    this.clearSilenceTimer();
    await this.startPromise?.catch(() => {});
    await this.provider?.stop();
    this.provider = undefined;
    this.ws.send('voice.state', { state: 'idle' });
  }
}
