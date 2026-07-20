import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LocalCascadeProvider,
  type VadEngine,
  type SttEngine,
  type TtsEngine,
  type TtsClip,
} from './LocalCascadeProvider.js';
import type { VoiceStartOptions, VoiceProviderState } from './VoiceProvider.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Flush pending microtasks without timers (safe under vi.useFakeTimers). */
const micro = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Fake VAD that lets the test push speech-start / utterance-end on demand. */
class FakeVad implements VadEngine {
  fire?: (pcm: Float32Array) => void;
  onSpeechStart?: () => void;
  startCount = 0;
  stopCount = 0;
  async start(onUtterance: (pcm: Float32Array) => void, onSpeechStart?: () => void): Promise<void> {
    this.startCount++;
    this.fire = onUtterance;
    this.onSpeechStart = onSpeechStart;
  }
  stop(): void {
    this.stopCount++;
  }
}

class FakeStt implements SttEngine {
  constructor(private text: string) {}
  async transcribe(): Promise<string> {
    return this.text;
  }
}

/** STT whose results resolve only when the test releases them (ordering tests). */
class DeferredStt implements SttEngine {
  private resolvers: Array<(text: string) => void> = [];
  calls = 0;
  transcribe(): Promise<string> {
    this.calls++;
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
  release(text: string): void {
    this.resolvers.shift()?.(text);
  }
}

/** Fake TTS with the synthesize/play split; playback resolves immediately. */
class FakeTts implements TtsEngine {
  synthesized: string[] = [];
  played: string[] = [];
  stops = 0;
  async synthesize(text: string): Promise<TtsClip> {
    this.synthesized.push(text);
    return { play: async () => void this.played.push(text) };
  }
  stop(): void {
    this.stops++;
  }
}

/** Fake TTS where the test controls when each clip's playback finishes. */
class DeferredTts implements TtsEngine {
  synthesized: string[] = [];
  played: string[] = [];
  private playResolvers: Array<() => void> = [];
  stops = 0;
  async synthesize(text: string): Promise<TtsClip> {
    this.synthesized.push(text);
    return {
      play: () =>
        new Promise<void>((resolve) => {
          this.played.push(text);
          this.playResolvers.push(resolve);
        }),
    };
  }
  finishPlayback(): void {
    this.playResolvers.shift()?.();
  }
  stop(): void {
    this.stops++;
  }
}

function delegateCollector() {
  const states: VoiceProviderState[] = [];
  const userTx: string[] = [];
  const asstTx: string[] = [];
  const opts: VoiceStartOptions = {
    systemPrompt: 'x',
    tools: [],
    delegate: {
      onToolCall: async () => ({}),
      onUserTranscript: (t) => userTx.push(t),
      onAssistantTranscript: (t) => asstTx.push(t),
      onStateChange: (s) => states.push(s),
      onError: () => {},
    },
  };
  return { opts, states, userTx, asstTx };
}

/** ms of silence-shaped PCM at the VAD's 16 kHz sample rate. */
function pcmOfMs(ms: number): Float32Array {
  return new Float32Array(Math.round((ms / 1000) * 16000));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('LocalCascadeProvider', () => {
  it('turns a spoken utterance into a user transcript (STT)', async () => {
    const vad = new FakeVad();
    const provider = new LocalCascadeProvider({
      vad,
      stt: new FakeStt('what is two plus two'),
      tts: new FakeTts(),
    });
    const { opts, userTx, states } = delegateCollector();
    await provider.start(opts);
    expect(states).toContain('listening');

    vad.fire!(pcmOfMs(800));
    await tick();
    expect(userTx).toEqual(['what is two plus two']);
  });

  it('serializes STT so rapid utterances deliver transcripts in order', async () => {
    const vad = new FakeVad();
    const stt = new DeferredStt();
    const provider = new LocalCascadeProvider({ vad, stt, tts: new FakeTts() });
    const { opts, userTx } = delegateCollector();
    await provider.start(opts);

    vad.fire!(pcmOfMs(800)); // slow first utterance
    await tick();
    vad.fire!(pcmOfMs(800)); // second arrives while the first transcribes

    stt.release('first');
    await tick();
    stt.release('second');
    await tick();

    expect(userTx).toEqual(['first', 'second']);
  });

  it('speaks injected assistant text via TTS and returns to listening', async () => {
    const tts = new FakeTts();
    const provider = new LocalCascadeProvider({ vad: new FakeVad(), stt: new FakeStt(''), tts });
    const { opts, asstTx, states } = delegateCollector();
    await provider.start(opts);

    await provider.injectAssistantContext('four');
    expect(tts.synthesized).toEqual(['four']);
    expect(tts.played).toEqual(['four']);
    expect(asstTx).toEqual(['four']);
    expect(states).toContain('talking');
    expect(states[states.length - 1]).toBe('listening');
  });

  it('synthesizes the next sentence while the previous one is still playing', async () => {
    const tts = new DeferredTts();
    const provider = new LocalCascadeProvider({ vad: new FakeVad(), stt: new FakeStt(''), tts });
    const { opts } = delegateCollector();
    await provider.start(opts);

    const first = provider.injectAssistantContext('sentence one.');
    await tick(); // sentence one synthesized and now playing (held open)
    const second = provider.injectAssistantContext('sentence two.');
    await tick();

    // Pipelining: two is synthesized while one is still audible.
    expect(tts.synthesized).toEqual(['sentence one.', 'sentence two.']);
    expect(tts.played).toEqual(['sentence one.']);

    tts.finishPlayback();
    await tick();
    expect(tts.played).toEqual(['sentence one.', 'sentence two.']); // strict order
    tts.finishPlayback();
    await Promise.all([first, second]);
  });

  it('barge-in: user speech start stops current TTS when not talking', async () => {
    const tts = new FakeTts();
    const vad = new FakeVad();
    const provider = new LocalCascadeProvider({ vad, stt: new FakeStt('hi'), tts });
    const { opts } = delegateCollector();
    await provider.start(opts);

    vad.onSpeechStart!(); // user starts talking while we're idle-listening
    expect(tts.stops).toBeGreaterThan(0);
  });

  describe('half-duplex echo guard (while talking)', () => {
    async function talkingProvider(sustainedMs = 300, minUtteranceMs = 350) {
      const tts = new DeferredTts();
      const vad = new FakeVad();
      const provider = new LocalCascadeProvider({
        vad,
        stt: new FakeStt('real words'),
        tts,
        bargeIn: { sustainedMs, minUtteranceMs },
      });
      const col = delegateCollector();
      await provider.start(col.opts);
      void provider.injectAssistantContext('a long reply that keeps playing');
      await micro(); // now playing → state 'talking' (microtasks only: fake-timer safe)
      return { provider, vad, tts, ...col };
    }

    it('drops a short echo blip without cutting TTS', async () => {
      vi.useFakeTimers();
      const { vad, tts, userTx } = await talkingProvider();

      vad.onSpeechStart!(); // "speech" begins — could be our own echo
      await vi.advanceTimersByTimeAsync(100); // ends inside the sustain window
      vad.fire!(pcmOfMs(120)); // ...and it was tiny → echo
      await vi.advanceTimersByTimeAsync(0);

      expect(tts.stops).toBe(0); // TTS keeps playing
      expect(userTx).toEqual([]); // nothing transcribed
    });

    it('treats sustained speech as a real barge-in', async () => {
      vi.useFakeTimers();
      const { vad, tts } = await talkingProvider();

      vad.onSpeechStart!();
      await vi.advanceTimersByTimeAsync(300); // speech sustains past the window
      expect(tts.stops).toBeGreaterThan(0); // TTS cut
    });

    it('treats a long-enough short utterance as a barge-in too', async () => {
      vi.useFakeTimers();
      const { vad, tts, userTx } = await talkingProvider();

      vad.onSpeechStart!();
      await vi.advanceTimersByTimeAsync(100);
      vad.fire!(pcmOfMs(500)); // ended early but clearly a real utterance
      expect(tts.stops).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(userTx).toEqual(['real words']);
    });
  });

  it('muting releases the mic; unmuting re-acquires it', async () => {
    const tts = new FakeTts();
    const vad = new FakeVad();
    const provider = new LocalCascadeProvider({ vad, stt: new FakeStt('x'), tts });
    const { opts, userTx } = delegateCollector();
    await provider.start(opts);
    expect(vad.startCount).toBe(1);

    provider.setMicEnabled(false);
    expect(vad.stopCount).toBe(1); // capture released, not just gated

    // A stale VAD tap firing after release must be ignored.
    vad.fire!(pcmOfMs(800));
    await tick();
    expect(userTx).toEqual([]);

    provider.setMicEnabled(true);
    await tick();
    expect(vad.startCount).toBe(2); // re-acquired
    vad.fire!(pcmOfMs(800));
    await tick();
    expect(userTx).toEqual(['x']);
  });

  it('muting blocks barge-in (speech start does not cut TTS while muted)', async () => {
    const tts = new FakeTts();
    const vad = new FakeVad();
    const provider = new LocalCascadeProvider({ vad, stt: new FakeStt('x'), tts });
    const { opts } = delegateCollector();
    await provider.start(opts);

    provider.setMicEnabled(false);
    vad.onSpeechStart!(); // stale tap while muted
    expect(tts.stops).toBe(0); // TTS not cut

    provider.setMicEnabled(true);
    await tick();
    vad.onSpeechStart!(); // now barge-in works
    expect(tts.stops).toBeGreaterThan(0);
  });

  it('interrupt() and stop() gate the pipeline', async () => {
    const tts = new FakeTts();
    const vad = new FakeVad();
    const provider = new LocalCascadeProvider({ vad, stt: new FakeStt('ignored'), tts });
    const { opts, userTx } = delegateCollector();
    await provider.start(opts);

    await provider.interrupt();
    expect(tts.stops).toBeGreaterThan(0);

    await provider.stop();
    expect(vad.stopCount).toBeGreaterThan(0);
    vad.fire!(pcmOfMs(800));
    await tick();
    expect(userTx).toEqual([]); // stopped → no transcript
  });
});
