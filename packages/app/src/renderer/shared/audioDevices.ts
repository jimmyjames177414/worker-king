/**
 * Audio-device helpers shared by the renderers.
 *
 * `audioInputConstraints` turns a chosen microphone id into a getUserMedia
 * constraint (falling back to the system default when unset). Output routing uses
 * `HTMLMediaElement.setSinkId`, which some engines/platforms don't support — the
 * helpers degrade to a no-op there rather than throwing. `applyOutputDeviceToDom`
 * routes every <audio> element the voice layer injects (the realtime SDK adds one
 * for playback) to the selected speaker.
 */

export function audioInputConstraints(deviceId?: string): MediaStreamConstraints {
  return { audio: deviceId ? { deviceId: { exact: deviceId } } : true };
}

interface SinkCapable {
  setSinkId?(deviceId: string): Promise<void>;
}

/** Route one media element to `deviceId`. Returns false when unset/unsupported. */
export async function applyOutputDevice(el: SinkCapable, deviceId?: string): Promise<boolean> {
  if (!deviceId || typeof el.setSinkId !== 'function') return false;
  try {
    await el.setSinkId(deviceId);
    return true;
  } catch {
    return false; // e.g. device gone, or permission missing
  }
}

interface AudioRoot {
  querySelectorAll(selector: string): ArrayLike<SinkCapable>;
}

/** Route every <audio> element under `root` to `deviceId`; returns how many succeeded. */
export async function applyOutputDeviceToDom(
  deviceId: string | undefined,
  root: AudioRoot,
): Promise<number> {
  if (!deviceId) return 0;
  let routed = 0;
  for (const el of Array.from(root.querySelectorAll('audio'))) {
    if (await applyOutputDevice(el, deviceId)) routed++;
  }
  return routed;
}
