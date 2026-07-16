/**
 * HotkeyManager — owns the two global shortcuts (push-to-talk + explain-selection)
 * and their re-registration state, extracted from the Electron `main` god file so
 * the register/replace logic is a single testable unit instead of loose
 * module-scope mutables (`currentHotkey`/`currentExplainHotkey`).
 *
 * The shortcut primitives are injected (Electron's `globalShortcut` in prod, a
 * fake in tests) so this has no hard Electron dependency.
 */

/** The subset of Electron's globalShortcut this needs. */
export interface ShortcutApi {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  unregisterAll(): void;
}

export interface HotkeyHandlers {
  pushToTalk: () => void;
  explain: () => void;
}

export class HotkeyManager {
  private pushToTalkAccel = '';
  private explainAccel = '';

  constructor(
    private readonly api: ShortcutApi,
    private readonly handlers: HotkeyHandlers,
  ) {}

  /** (Re)bind push-to-talk, replacing any prior binding. Returns false if taken or invalid. */
  setPushToTalk(accelerator: string): boolean {
    return this.rebind('pushToTalkAccel', accelerator, this.handlers.pushToTalk);
  }

  /** (Re)bind the explain-selection shortcut, replacing any prior binding. */
  setExplain(accelerator: string): boolean {
    return this.rebind('explainAccel', accelerator, this.handlers.explain);
  }

  /** Release both shortcuts (on quit). */
  unregisterAll(): void {
    this.api.unregisterAll();
    this.pushToTalkAccel = '';
    this.explainAccel = '';
  }

  /**
   * Swap a field's binding to a new accelerator. `register` returns false when
   * the chord is taken and THROWS when the accelerator is unparseable (e.g. a
   * dead key or 'Ù' from a non-US layout), so both failure modes are handled:
   * the new accelerator is only stored when it actually registered, and on
   * failure the previous binding is re-registered so the hotkey keeps working.
   */
  private rebind(
    field: 'pushToTalkAccel' | 'explainAccel',
    accelerator: string,
    callback: () => void,
  ): boolean {
    const prev = this[field];
    const other = field === 'pushToTalkAccel' ? this.explainAccel : this.pushToTalkAccel;
    // Don't unregister a chord the other hotkey still owns.
    if (prev && prev !== other) this.api.unregister(prev);

    let ok = false;
    try {
      ok = this.api.register(accelerator, callback);
    } catch {
      ok = false; // unparseable accelerator
    }
    if (ok) {
      this[field] = accelerator;
      return true;
    }

    // Failed — restore the previous binding (if we released it) and keep it stored.
    if (prev && prev !== other) {
      try {
        this.api.register(prev, callback);
      } catch {
        /* previous accelerator can no longer register; nothing to restore */
      }
    }
    return false;
  }
}
