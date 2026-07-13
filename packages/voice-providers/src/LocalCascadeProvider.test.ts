import { describe, it, expect } from 'vitest';
import { LocalCascadeProvider, type VadEngine, type SttEngine, type TtsEngine } from './LocalCascadeProvider.js';
import type { VoiceStartOptions, VoiceProviderState } from './VoiceProvider.js';

/** Fake VAD that lets the test push an utterance on demand. */
class FakeVad implements VadEngine {
  fire?: (pcm: Float32Array) => void;
  onSpeechStart?: () => void;
  stopped = false;
  async start(onUtterance: (pcm: Float32Array) => void, onSpeechStart?: () => void): Promise<void> {
    this.fire = onUtterance;
    this.onSpeechStart = onSpeechStart;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeStt implements SttEngine {
  constructor(private text: string) {}
  async transcribe(): Promise<string> {
    return this.text;
  }
}

class FakeTts implements TtsEngine {
  spoken: string[] = [];
  stops = 0;
  async speak(text: string): Promise<void> {
    this.spoken.push(text);
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

describe('LocalCascadeProvider', () => {
  it('turns a spoken utterance into a user transcript (STT)', async () => {
    const vad = new FakeVad();
    const provider = new LocalCascadeProvider({ vad, stt: new FakeStt('what is two plus two'), tts: new FakeTts() });
    const { opts, userTx, states } = delegateCollector();
    await provider.start(opts);
    expect(states).toContain('listening');

    vad.fire!(new Float32Array([0.1, 0.2]));
    await new Promise((r) => setTimeout(r, 0));
    expect(userTx).toEqual(['what is two plus two']);
  });

  it('speaks injected assistant text via TTS and returns to listening', async () => {
    const tts = new FakeTts();
    const provider = new LocalCascadeProvider({ vad: new FakeVad(), stt: new FakeStt(''), tts });
    const { opts, asstTx, states } = delegateCollector();
    await provider.start(opts);

    await provider.injectAssistantContext('four');
    expect(tts.spoken).toEqual(['four']);
    expect(asstTx).toEqual(['four']);
    expect(states).toContain('talking');
    expect(states[states.length - 1]).toBe('listening');
  });

  it('barge-in: user speech start stops current TTS', async () => {
    const tts = new FakeTts();
    const vad = new FakeVad();
    const provider = new LocalCascadeProvider({ vad, stt: new FakeStt('hi'), tts });
    const { opts } = delegateCollector();
    await provider.start(opts);

    vad.onSpeechStart!(); // user starts talking
    expect(tts.stops).toBeGreaterThan(0);
  });

  it('muting blocks barge-in (speech start does not cut TTS while muted)', async () => {
    const tts = new FakeTts();
    const vad = new FakeVad();
    const provider = new LocalCascadeProvider({ vad, stt: new FakeStt('x'), tts });
    const { opts } = delegateCollector();
    await provider.start(opts);

    provider.setMicEnabled(false);
    vad.onSpeechStart!(); // user talks while muted
    expect(tts.stops).toBe(0); // TTS not cut

    provider.setMicEnabled(true);
    vad.onSpeechStart!(); // now barge-in works
    expect(tts.stops).toBeGreaterThan(0);
  });

  it('interrupt() and mute gate the pipeline', async () => {
    const tts = new FakeTts();
    const vad = new FakeVad();
    const provider = new LocalCascadeProvider({ vad, stt: new FakeStt('ignored'), tts });
    const { opts, userTx } = delegateCollector();
    await provider.start(opts);

    await provider.interrupt();
    expect(tts.stops).toBeGreaterThan(0);

    provider.setMicEnabled(false);
    vad.fire!(new Float32Array([0.1]));
    await new Promise((r) => setTimeout(r, 0));
    expect(userTx).toEqual([]); // muted → no transcript

    await provider.stop();
    expect(vad.stopped).toBe(true);
  });
});
