import { connectToDaemon } from '../shared/wsClient.js';
import { AvatarController } from './AvatarController.js';
import { Captions } from './Captions.js';
import { VoiceHost } from './VoiceHost.js';
import { WakeWordController, createWakeWordDetector, shouldWakeListen } from './WakeWord.js';
import { applyOutputDeviceToDom } from '../shared/audioDevices.js';
import { applyTheme, normalizeThemePref } from '../shared/theme.js';
import { describeError } from '../shared/describeError.js';

/**
 * Overlay renderer entry. Wires:
 *  - the avatar element to the AvatarController (driven by avatar.state broadcasts)
 *  - left-click on the avatar to toggle the voice session
 *  - right-click on the avatar to open the chat window
 */
const bridge = (
  window as unknown as {
    workerking: {
      setClickThrough(on: boolean): void;
      openChat(): void;
      mintRealtimeKey(): Promise<string>;
      onPushToTalk(cb: () => void): void;
      onReconnect(cb: () => void): void;
      onSpeak(cb: (text: string) => void): void;
    };
  }
).workerking;

async function main(): Promise<VoiceHost | undefined> {
  const avatarEl = document.getElementById('avatar');
  if (!avatarEl) throw new Error('avatar element missing');
  const avatar = new AvatarController(avatarEl);

  const captionsEl = document.getElementById('captions');
  const captions = captionsEl ? new Captions(captionsEl) : undefined;

  let client;
  try {
    client = await connectToDaemon();
  } catch (err) {
    avatar.set('alert');
    console.error('overlay: daemon connection failed', err);
    return;
  }

  // A live voice session owns the avatar: while it's active (mic/thinking/
  // talking), ignore the daemon's agent-busy avatar.state so a background task's
  // "thinking" doesn't stomp the voice state. When no voice session is active,
  // avatar.state drives the companion — so you see it "working" during silent
  // delegated tasks.
  let voiceActive = false;
  client.on('avatar.state', (env) => {
    if (voiceActive) return;
    avatar.set(env.payload.state);
  });
  client.on('welcome', () => avatar.set('idle'));

  // Preferred audio devices (system default until config arrives).
  let inputDeviceId: string | undefined;
  let outputDeviceId: string | undefined;
  const asStr = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

  // Heal the WS link after system resume (WSL localhost forwarding can drop).
  bridge.onReconnect(() => client.reconnect());

  // Reflect the voice provider's own state onto the avatar.
  client.on('voice.state', (env) => {
    const map: Record<string, Parameters<AvatarController['set']>[0]> = {
      idle: 'idle',
      listening: 'listening',
      thinking: 'thinking',
      talking: 'talking',
      error: 'alert',
    };
    // Voice owns the avatar while its session is live; released back to
    // agent-busy (avatar.state) once it returns to idle.
    voiceActive = env.payload.state !== 'idle';
    avatar.set(map[env.payload.state] ?? 'idle');
    // The voice layer injects its <audio> when a session starts; route it to the
    // chosen output device once it exists.
    if (env.payload.state !== 'idle') void applyOutputDeviceToDom(outputDeviceId, document);
  });

  // Live captions from voice transcripts (2.1).
  client.on('voice.transcript', (env) => {
    captions?.show(env.payload.role, env.payload.text);
  });

  // Audio-reactive avatar (2.2): output amplitude drives the mouth/scale.
  client.on('voice.audio_level', (env) => avatar.setLevel(env.payload.level));

  // The daemon assembles the full voice system prompt (behavioral base +
  // capability list + level-gated ambient context) and pushes it via
  // voice.context. Keep the latest; getPersona() returns it. A minimal fallback
  // covers the window before the first push (or a run without the real brain).
  const VOICE_FALLBACK_PROMPT =
    'You are WorkerKing, a concise desktop voice assistant. For anything substantive — running ' +
    'commands, editing files, or answering questions that need tools — say a short filler like ' +
    '"On it", then call delegate_to_worker; read out progress and results naturally.';
  let latestVoicePrompt: string | undefined;

  // Voice: push-to-talk (global hotkey) toggles a GPT Realtime session.
  const voiceHost = new VoiceHost(client, bridge, () => latestVoicePrompt ?? VOICE_FALLBACK_PROMPT);

  // A fresh voice context: store it (next session start uses it) and hot-patch a
  // live session in place so a settings/persona change applies without restart.
  client.on('voice.context', (env) => {
    latestVoicePrompt = env.payload.systemPrompt;
    voiceHost.updateContext(latestVoicePrompt);
  });

  // Left-click toggles voice (hotkey is wired inside VoiceHost); right-click opens chat.
  avatarEl.addEventListener('click', () => {
    console.log('[workerking] avatar clicked');
    void voiceHost.toggle();
  });
  avatarEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    bridge.openChat();
  });

  // Wake word (2.3, opt-in): when enabled in config, "Hey <name>" starts a
  // session (start-only — a detection can never stop a live session). The
  // controller is suspended while a voice session is active so there's exactly
  // one open mic and the detector never hears the assistant's own TTS.
  const wake = new WakeWordController(
    await createWakeWordDetector(),
    () => void voiceHost.startIfIdle(),
  );
  let wakeWordEnabled = false;
  let voiceState = 'idle';
  const syncWake = () => {
    const listen = shouldWakeListen(wakeWordEnabled, voiceState);
    if (listen && !wake.isEnabled()) {
      console.debug(
        `[wake] syncWake: enabling (wakeWordEnabled=${wakeWordEnabled}, voiceState=${voiceState})`,
      );
      void wake
        .enable(inputDeviceId)
        .catch((e) => console.error('[wake] enable failed', describeError(e)));
    } else if (!listen && wake.isEnabled()) {
      console.debug(
        `[wake] syncWake: disabling (wakeWordEnabled=${wakeWordEnabled}, voiceState=${voiceState})`,
      );
      wake.disable();
    }
  };
  client.on('voice.state', (env) => {
    voiceState = env.payload.state;
    syncWake();
  });
  client.on('config.changed', (env) => {
    if (env.payload.key === 'wakeWordEnabled') {
      wakeWordEnabled = env.payload.value === true;
      syncWake();
    }
    if (env.payload.key === 'inputDeviceId') {
      inputDeviceId = asStr(env.payload.value);
      if (wake.isEnabled()) {
        wake.disable();
        syncWake();
      }
    }
    if (env.payload.key === 'outputDeviceId') {
      outputDeviceId = asStr(env.payload.value);
      void applyOutputDeviceToDom(outputDeviceId, document);
    }
    if (env.payload.key === 'theme') applyTheme(normalizeThemePref(env.payload.value));
  });
  client.send('config.get', { key: 'inputDeviceId' });
  client.send('config.get', { key: 'outputDeviceId' });
  client.send('config.get', { key: 'theme' });
  client.send('config.get', { key: 'wakeWordEnabled' });

  // Proactive notices (reminders, watch heads-ups, notify tool): show a caption
  // and speak them if a voice session is active.
  client.on('proactive.notify', (env) => {
    captions?.show('assistant', env.payload.text);
    if (env.payload.speak) void voiceHost.speak(env.payload.text);
  });
  // Explain-hotkey replies routed from main.
  bridge.onSpeak((text) => {
    captions?.show('assistant', text);
    void voiceHost.speak(text);
  });

  return voiceHost;
}

let _voiceHost: VoiceHost | undefined;
void main().then((h) => {
  _voiceHost = h;
});

// Close the voice session on page unload so OpenAI doesn't hold a stale session
// across HMR reloads or F5 restarts.
window.addEventListener('beforeunload', () => {
  void _voiceHost?.stop();
});
