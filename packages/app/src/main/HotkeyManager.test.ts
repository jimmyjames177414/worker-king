import { describe, it, expect, vi } from 'vitest';
import { HotkeyManager, type ShortcutApi } from './HotkeyManager.js';

function fakeApi(registerReturns = true) {
  const registered = new Map<string, () => void>();
  const api: ShortcutApi = {
    register: vi.fn((accel: string, cb: () => void) => {
      if (!registerReturns) return false;
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
    const { api } = fakeApi(false);
    const hk = new HotkeyManager(api, { pushToTalk: vi.fn(), explain: vi.fn() });
    expect(hk.setPushToTalk('Control+Shift+Space')).toBe(false);
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
