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

  /** (Re)bind push-to-talk, replacing any prior binding. Returns false if taken. */
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

  private rebind(
    field: 'pushToTalkAccel' | 'explainAccel',
    accelerator: string,
    callback: () => void,
  ): boolean {
    const prev = this[field];
    if (prev) this.api.unregister(prev);
    this[field] = accelerator;
    return this.api.register(accelerator, callback);
  }
}
