import { connectToDaemon } from '../shared/wsClient.js';
import { AvatarController } from './AvatarController.js';

/**
 * Overlay renderer entry. Wires:
 *  - the avatar element to the AvatarController (driven by avatar.state broadcasts)
 *  - hover over the avatar to click-through toggling (so it's draggable/clickable
 *    only over the sprite, click-through everywhere else)
 *  - a click on the avatar to open the chat window (Phase 0 uses config path; here
 *    we just surface a custom event other phases hook)
 */
const bridge = (window as unknown as {
  workerking: { setClickThrough(on: boolean): void };
}).workerking;

async function main(): Promise<void> {
  const avatarEl = document.getElementById('avatar');
  if (!avatarEl) throw new Error('avatar element missing');
  const avatar = new AvatarController(avatarEl);

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

  // Reflect the voice provider's own state onto the avatar in later phases.
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
}

main();
