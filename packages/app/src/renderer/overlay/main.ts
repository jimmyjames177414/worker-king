import { connectToDaemon } from '../shared/wsClient.js';
import { AvatarController } from './AvatarController.js';
import { Captions } from './Captions.js';
import { VoiceHost } from './VoiceHost.js';
import { WakeWordController, NullWakeWordDetector } from './WakeWord.js';

/**
 * Overlay renderer entry. Wires:
 *  - the avatar element to the AvatarController (driven by avatar.state broadcasts)
 *  - hover over the avatar to click-through toggling (so it's draggable/clickable
 *    only over the sprite, click-through everywhere else)
 *  - a click on the avatar to open the chat window (Phase 0 uses config path; here
 *    we just surface a custom event other phases hook)
 */
const bridge = (window as unknown as {
  workerking: {
    setClickThrough(on: boolean): void;
    mintRealtimeKey(): Promise<string>;
    onPushToTalk(cb: () => void): void;
    onReconnect(cb: () => void): void;
    onSpeak(cb: (text: string) => void): void;
  };
}).workerking;

async function main(): Promise<void> {
  const avatarEl = document.getElementById('avatar');
  if (!avatarEl) throw new Error('avatar element missing');
  const avatar = new AvatarController(avatarEl);

  const captionsEl = document.getElementById('captions');
  const captions = captionsEl ? new Captions(captionsEl) : undefined;

  // Hover makes the overlay solid so the avatar is interactive; leaving restores
  // full click-through to the desktop.
  avatarEl.addEventListener('mouseenter', () => bridge.setClickThrough(false));
  avatarEl.addEventListener('mouseleave', () => bridge.setClickThrough(true));

  let client;
  try {
    client = await connectToDaemon();
  } catch (err) {
    avatar.set('alert');
    console.error('overlay: daemon connection failed', err);
    return;
  }

  client.on('avatar.state', (env) => avatar.set(env.payload.state));
  client.on('welcome', () => avatar.set('idle'));

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
    avatar.set(map[env.payload.state] ?? 'idle');
  });

  // Live captions from voice transcripts (2.1).
  client.on('voice.transcript', (env) => {
    captions?.show(env.payload.role, env.payload.text);
  });

  // Audio-reactive avatar (2.2): output amplitude drives the mouth/scale.
  client.on('voice.audio_level', (env) => avatar.setLevel(env.payload.level));

  // Track the live capability summary so the voice model knows what it can route to.
  let capabilitySummary = '';
  client.on('capability.updated', (env) => {
    capabilitySummary = env.payload.manifest.voiceSummary;
  });

  // Voice: push-to-talk (global hotkey) toggles a GPT Realtime session.
  const voiceHost = new VoiceHost(client, bridge, () => {
    const base = [
      'You are WorkerKing, a helpful desktop voice assistant. Keep spoken replies concise and natural.',
      'You are a thin voice layer over a capable worker (Claude Code). Handle greetings and small talk',
      'yourself, but for ANYTHING substantive — running commands, editing files, answering questions that',
      'need tools — first say a short filler like "On it" or "Let me take care of that", then call',
      'delegate_to_worker with the task. Progress and results will be spoken to the user automatically as',
      'they arrive; read them out naturally. Use check_task_status if the user asks how it\'s going, and',
      'cancel_task if they want to stop.',
    ].join(' ');
    return capabilitySummary ? `${base}\n\n${capabilitySummary}` : base;
  });

  // Wake word (2.3, opt-in): when enabled in config, "Hey <name>" triggers the
  // same session start as the hotkey. Detector is a no-op until a real model is
  // installed (see WakeWord.ts).
  const wake = new WakeWordController(new NullWakeWordDetector(), () => void voiceHost.toggle());
  const applyWakeConfig = (enabled: unknown) => {
    if (enabled === true) void wake.enable().catch((e) => console.error('[wake] enable failed', e));
    else wake.disable();
  };
  client.on('config.changed', (env) => {
    if (env.payload.key === 'wakeWordEnabled') applyWakeConfig(env.payload.value);
  });
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
}

main();
