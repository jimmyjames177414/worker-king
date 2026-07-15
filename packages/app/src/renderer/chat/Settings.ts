import { characterCardV2Schema } from '@workerking/shared';
import { formatAccelerator } from './accelerator.js';

/** The chat preload bridge surface Settings needs. */
export interface SettingsBridge {
  getConfig(): Promise<Record<string, unknown>>;
  setConfig(key: string, value: unknown): Promise<void>;
  setSecret(key: string, value: string): Promise<void>;
  hasSecret(key: string): Promise<boolean>;
}

/**
 * Settings panel — the configurable-in-all-aspects surface: name, personality,
 * voice, model, hotkey, toggles, OpenAI key entry, and character-card import.
 * Writes go through the bridge → main (persist) → daemon (live reload).
 */
export class Settings {
  constructor(
    private readonly el: HTMLElement,
    private readonly bridge: SettingsBridge,
  ) {}

  async render(): Promise<void> {
    const cfg = await this.bridge.getConfig();
    const hasKey = await this.bridge.hasSecret('openai');
    const devices = await this.enumerateDevices();
    this.el.innerHTML = this.template(cfg, hasKey, devices);
    this.wire();
  }

  private async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    try {
      return await navigator.mediaDevices.enumerateDevices();
    } catch {
      return [];
    }
  }

  private template(cfg: Record<string, unknown>, hasKey: boolean, devices: MediaDeviceInfo[]): string {
    const str = (k: string) => escapeHtml(String(cfg[k] ?? ''));
    const checked = (k: string) => (cfg[k] === true ? 'checked' : '');
    const deviceOpts = (kind: MediaDeviceKind, selected: unknown) => {
      const opts = devices
        .filter((d) => d.kind === kind)
        .map(
          (d) =>
            `<option value="${escapeHtml(d.deviceId)}" ${selected === d.deviceId ? 'selected' : ''}>${escapeHtml(d.label || d.deviceId || 'device')}</option>`,
        );
      return `<option value="" ${selected ? '' : 'selected'}>System default</option>${opts.join('')}`;
    };
    const modelOpts = ['gpt-realtime-mini', 'gpt-realtime']
      .map((m) => `<option value="${m}" ${cfg.openaiModel === m ? 'selected' : ''}>${m}</option>`)
      .join('');
    const providerOpts = [
      ['gpt-realtime', 'OpenAI Realtime (cloud)'],
      ['local-cascade', 'Local cascade (offline)'],
    ]
      .map(
        ([v, label]) =>
          `<option value="${v}" ${cfg.voiceProvider === v ? 'selected' : ''}>${label}</option>`,
      )
      .join('');
    const hostOpts = ['auto', 'windows', 'wsl']
      .map((h) => `<option value="${h}" ${cfg.claudeHost === h ? 'selected' : ''}>${h}</option>`)
      .join('');
    const themeOpts = [
      ['system', 'System'],
      ['light', 'Light'],
      ['dark', 'Dark'],
    ]
      .map(([v, label]) => `<option value="${v}" ${cfg.theme === v ? 'selected' : ''}>${label}</option>`)
      .join('');
    return `
      <h2>Settings</h2>
      <label>Assistant name<input data-cfg="assistantName" value="${str('assistantName')}"></label>
      <label>Theme<select data-cfg="theme">${themeOpts}</select></label>
      <label>Your name<input data-cfg="userName" value="${str('userName')}" placeholder="how it addresses you"></label>
      <label>Personality<textarea data-cfg="personality" rows="3">${str('personality')}</textarea></label>
      <label>Voice engine<select data-cfg="voiceProvider">${providerOpts}</select></label>
      <label>Voice model<select data-cfg="openaiModel">${modelOpts}</select></label>
      <label>Microphone<select data-cfg="inputDeviceId">${deviceOpts('audioinput', cfg.inputDeviceId)}</select></label>
      <label>Speaker<select data-cfg="outputDeviceId">${deviceOpts('audiooutput', cfg.outputDeviceId)}</select></label>
      <label>Claude host<select data-cfg="claudeHost">${hostOpts}</select></label>
      <label>Push-to-talk hotkey<input data-cfg="hotkey" data-hotkey readonly value="${str('hotkey')}" placeholder="Click, then press keys"></label>
      <label>"Explain selection" hotkey<input data-cfg="explainHotkey" data-hotkey readonly value="${str('explainHotkey')}" placeholder="Click, then press keys"></label>
      <label class="check"><input type="checkbox" data-cfg="wakeWordEnabled" ${checked('wakeWordEnabled')}> Always-listening wake word</label>
      <label class="check"><input type="checkbox" data-cfg="screenAwareness" ${checked('screenAwareness')}> Let it see my screen</label>
      <label class="check"><input type="checkbox" data-cfg="memoryEnabled" ${checked('memoryEnabled')}> Remember things about me across sessions</label>
      <label class="check"><input type="checkbox" data-cfg="semanticMemory" ${checked('semanticMemory')}> Smarter memory search (local embeddings)</label>
      <label class="check"><input type="checkbox" data-cfg="remindersEnabled" ${checked('remindersEnabled')}> Allow reminders</label>
      <label class="check"><input type="checkbox" data-cfg="proactiveEnabled" ${checked('proactiveEnabled')}> Proactive heads-ups (calendar etc.)</label>
      <hr>
      <label>OpenAI API key ${hasKey ? '<span class="ok">✓ saved</span>' : '<span class="warn">not set</span>'}
        <span class="row"><input type="password" id="openai-key" placeholder="sk-..."><button id="save-key">Save</button></span>
      </label>
      <hr>
      <label>Character card
        <span class="row"><input type="file" id="card-file" accept="application/json"><span id="card-status"></span></span>
      </label>
      <p id="settings-status" class="status"></p>
    `;
  }

  private wire(): void {
    // Text/select/textarea → setConfig on change (hotkey fields handled separately).
    this.el.querySelectorAll<HTMLElement>('[data-cfg]').forEach((node) => {
      if (node.hasAttribute('data-hotkey')) return;
      const key = node.dataset.cfg!;
      const input = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const isCheckbox = input instanceof HTMLInputElement && input.type === 'checkbox';
      input.addEventListener('change', () => {
        const value = isCheckbox ? (input as HTMLInputElement).checked : input.value;
        void this.bridge.setConfig(key, value).then(() => this.status(`Saved ${key}.`));
      });
    });

    // Hotkey fields: click to record, then capture the next chord as an accelerator.
    this.el.querySelectorAll<HTMLInputElement>('input[data-hotkey]').forEach((input) => {
      const key = input.dataset.cfg!;
      input.addEventListener('focus', () => {
        input.dataset['prev'] = input.value;
        input.value = '';
      });
      input.addEventListener('blur', () => {
        if (!input.value) input.value = input.dataset['prev'] ?? '';
      });
      input.addEventListener('keydown', (e) => {
        e.preventDefault();
        const accelerator = formatAccelerator(e);
        if (!accelerator) return; // wait for a non-modifier key
        input.value = accelerator;
        input.blur();
        void this.bridge.setConfig(key, accelerator).then(() => this.status(`Saved ${key}.`));
      });
    });

    // OpenAI key (write-only).
    const keyInput = this.el.querySelector<HTMLInputElement>('#openai-key');
    this.el.querySelector('#save-key')?.addEventListener('click', () => {
      const v = keyInput?.value.trim();
      if (!v) return;
      void this.bridge.setSecret('openai', v).then(() => {
        if (keyInput) keyInput.value = '';
        void this.render(); // refresh the "saved" badge
      });
    });

    // Character-card import: read → validate → set as active persona.
    const cardStatus = this.el.querySelector('#card-status');
    this.el.querySelector<HTMLInputElement>('#card-file')?.addEventListener('change', async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const card = characterCardV2Schema.parse(JSON.parse(await file.text()));
        await this.bridge.setConfig('characterCard', card);
        await this.bridge.setConfig('assistantName', card.data.name);
        if (cardStatus) cardStatus.textContent = `Loaded "${card.data.name}"`;
        void this.render();
      } catch (err) {
        if (cardStatus) cardStatus.textContent = `Invalid card: ${String(err)}`;
      }
    });
  }

  private status(msg: string): void {
    const s = this.el.querySelector('#settings-status');
    if (s) s.textContent = msg;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
