import { describe, it, expect, vi } from 'vitest';
import { HotkeyManager, type ShortcutApi } from './HotkeyManager.js';

/**
 * Fake globalShortcut. `behavior` decides the outcome per accelerator:
 * true = registers, false = taken, 'throw' = unparseable (Electron throws).
 */
function fakeApi(behavior: (accel: string) => boolean | 'throw' = () => true) {
  const registered = new Map<string, () => void>();
  const api: ShortcutApi = {
    register: vi.fn((accel: string, cb: () => void) => {
      const outcome = behavior(accel);
      if (outcome === 'throw') throw new Error(`invalid accelerator: ${accel}`);
      if (!outcome) return false;
      registered.set(accel, cb);
      return true;
    }),
    unregister: vi.fn((accel: string) => void registered.delete(accel)),
    unregisterAll: vi.fn(() => registered.clear()),
  };
  return { api, registered };
}

describe('HotkeyManager', () => {
  it('binds push-to-talk and explain to their handlers', () => {
    const { api, registered } = fakeApi();
    const pushToTalk = vi.fn();
    const explain = vi.fn();
    const hk = new HotkeyManager(api, { pushToTalk, explain });

    expect(hk.setPushToTalk('Control+Shift+Space')).toBe(true);
    expect(hk.setExplain('Control+Shift+E')).toBe(true);

    registered.get('Control+Shift+Space')!();
    registered.get('Control+Shift+E')!();
    expect(pushToTalk).toHaveBeenCalledOnce();
    expect(explain).toHaveBeenCalledOnce();
  });

  it('unregisters the previous accelerator when rebinding', () => {
    const { api } = fakeApi();
    const hk = new HotkeyManager(api, { pushToTalk: vi.fn(), explain: vi.fn() });

    hk.setPushToTalk('Control+A');
    hk.setPushToTalk('Control+B');
    expect(api.unregister).toHaveBeenCalledWith('Control+A');
  });

  it('reports failure when the accelerator is already taken', () => {
    const { api } = fakeApi(() => false);
    const hk = new HotkeyManager(api, { pushToTalk: vi.fn(), explain: vi.fn() });
    expect(hk.setPushToTalk('Control+Shift+Space')).toBe(false);
  });

  it('restores the previous binding when register returns false, and never stores the loser', () => {
    const { api, registered } = fakeApi((accel) => accel !== 'Control+Taken');
    const hk = new HotkeyManager(api, { pushToTalk: vi.fn(), explain: vi.fn() });

    hk.setPushToTalk('Control+A');
    expect(hk.setPushToTalk('Control+Taken')).toBe(false);
    // Old chord re-registered, failed one not live.
    expect(registered.has('Control+A')).toBe(true);
    expect(registered.has('Control+Taken')).toBe(false);
    // The stored accelerator stayed the old one: the next rebind releases it.
    (api.unregister as ReturnType<typeof vi.fn>).mockClear();
    hk.setPushToTalk('Control+B');
    expect(api.unregister).toHaveBeenCalledWith('Control+A');
    expect(api.unregister).not.toHaveBeenCalledWith('Control+Taken');
  });

  it('survives register throwing on an unparseable accelerator and restores the previous binding', () => {
    const { api, registered } = fakeApi((accel) => (accel === 'Ù' ? 'throw' : true));
    const hk = new HotkeyManager(api, { pushToTalk: vi.fn(), explain: vi.fn() });

    hk.setPushToTalk('Control+A');
    expect(() => hk.setPushToTalk('Ù')).not.toThrow();
    expect(hk.setPushToTalk('Ù')).toBe(false);
    expect(registered.has('Control+A')).toBe(true); // still bound
  });

  it('never unregisters a chord the other hotkey still owns', () => {
    const { api, registered } = fakeApi();
    const hk = new HotkeyManager(api, { pushToTalk: vi.fn(), explain: vi.fn() });

    // Both fields end up on the same chord (the fake api allows it).
    hk.setPushToTalk('Control+A');
    hk.setExplain('Control+A');
    // Moving explain away must not release push-to-talk's live 'Control+A'.
    hk.setExplain('Control+B');
    expect(api.unregister).not.toHaveBeenCalledWith('Control+A');
    expect(registered.has('Control+A')).toBe(true);
  });

  it('releases everything on unregisterAll', () => {
    const { api } = fakeApi();
    const hk = new HotkeyManager(api, { pushToTalk: vi.fn(), explain: vi.fn() });
    hk.setPushToTalk('Control+A');
    hk.unregisterAll();
    expect(api.unregisterAll).toHaveBeenCalledOnce();
    // After releasing, a rebind should not try to unregister a stale accelerator.
    (api.unregister as ReturnType<typeof vi.fn>).mockClear();
    hk.setPushToTalk('Control+C');
    expect(api.unregister).not.toHaveBeenCalled();
  });
});
