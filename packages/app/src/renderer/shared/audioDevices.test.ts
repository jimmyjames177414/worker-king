import { describe, it, expect } from 'vitest';
import {
  audioInputConstraints,
  applyOutputDevice,
  applyOutputDeviceToDom,
} from './audioDevices.js';

describe('audioInputConstraints', () => {
  it('requests the system default when no device is chosen', () => {
    expect(audioInputConstraints()).toEqual({ audio: true });
    expect(audioInputConstraints('')).toEqual({ audio: true });
  });

  it('pins an exact device when chosen', () => {
    expect(audioInputConstraints('mic-1')).toEqual({ audio: { deviceId: { exact: 'mic-1' } } });
  });
});

describe('applyOutputDevice', () => {
  it('calls setSinkId with the device id', async () => {
    let sink = '';
    const ok = await applyOutputDevice({ setSinkId: async (id) => void (sink = id) }, 'spk-2');
    expect(ok).toBe(true);
    expect(sink).toBe('spk-2');
  });

  it('is a no-op when unsupported or unset', async () => {
    expect(await applyOutputDevice({}, 'spk-2')).toBe(false); // no setSinkId
    expect(await applyOutputDevice({ setSinkId: async () => {} }, '')).toBe(false); // no device
  });

  it('swallows setSinkId failures', async () => {
    const ok = await applyOutputDevice(
      {
        setSinkId: async () => {
          throw new Error('device gone');
        },
      },
      'spk-2',
    );
    expect(ok).toBe(false);
  });
});

describe('applyOutputDeviceToDom', () => {
  it('routes every audio element and counts successes', async () => {
    const sinks: string[] = [];
    const el = () => ({ setSinkId: async (id: string) => void sinks.push(id) });
    const root = { querySelectorAll: () => [el(), el()] };
    expect(await applyOutputDeviceToDom('spk-9', root)).toBe(2);
    expect(sinks).toEqual(['spk-9', 'spk-9']);
  });

  it('does nothing without a device id', async () => {
    const root = { querySelectorAll: () => [{ setSinkId: async () => {} }] };
    expect(await applyOutputDeviceToDom(undefined, root)).toBe(0);
  });
});
