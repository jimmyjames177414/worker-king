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
 * Settings view — the configurable-in-all-aspects surface: name, personality,
 * voice, model, hotkey, toggles, OpenAI key entry, and character-card import.
 * Writes go through the bridge → main (persist) → daemon (live reload).
 *
 * The markup is card sections, but the contract `wire()` binds against is
 * unchanged: every control still carries `data-cfg` (plus `data-cfg-lines` for
 * newline-delimited arrays and `data-hotkey` for accelerator capture).
 */
export class Settings {
  constructor(
    private readonly el: HTMLElement,
    private readonly bridge: SettingsBridge,
    /** Danger zone: wipes the on-screen transcript (owned by main.ts). */
    private readonly onClearConversation?: () => void,
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

  private template(
    cfg: Record<string, unknown>,
    hasKey: boolean,
    devices: MediaDeviceInfo[],
  ): string {
    const str = (k: string) => escapeHtml(String(cfg[k] ?? ''));
    const checked = (k: string) => (cfg[k] === true ? 'checked' : '');
    /** string[] config → one path per textarea line. */
    const strLines = (k: string) =>
      escapeHtml(Array.isArray(cfg[k]) ? (cfg[k] as unknown[]).map(String).join('\n') : '');
    const deviceOpts = (kind: MediaDeviceKind, selected: unknown) => {
      const opts = devices
        .filter((d) => d.kind === kind)
        .map(
          (d) =>
            `<option value="${escapeHtml(d.deviceId)}" ${selected === d.deviceId ? 'selected' : ''}>${escapeHtml(d.label || d.deviceId || 'device')}</option>`,
        );
      return `<option value="" ${selected ? '' : 'selected'}>System default</option>${opts.join('')}`;
    };
    const select = (key: string, current: unknown, options: [string, string][]) =>
      `<select data-cfg="${key}">${options
        .map(
          ([v, label]) =>
            `<option value="${v}" ${current === v ? 'selected' : ''}>${label}</option>`,
        )
        .join('')}</select>`;

    // --- row shapes -------------------------------------------------------
    const info = (name: string, hint: string) =>
      `<div class="set__info"><div class="set__name">${name}</div><div class="set__hint">${hint}</div></div>`;
    const row = (name: string, hint: string, ctl: string) =>
      `<div class="set__row">${info(name, hint)}<div class="set__ctl">${ctl}</div></div>`;
    const stack = (name: string, hint: string, ctl: string) =>
      `<div class="set__row set__row--stack">${info(name, hint)}<div class="set__ctl">${ctl}</div></div>`;
    const toggle = (key: string, name: string, hint: string) =>
      `<label class="set__row set__toggle">${info(name, hint)}<input type="checkbox" data-cfg="${key}" ${checked(key)}><span class="set__switch"></span></label>`;
    const group = (label: string, body: string) =>
      `<section><div class="set__label">${label}</div><div class="card set__card">${body}</div></section>`;

    return `
      ${group(
        'Identity',
        row(
          'Assistant name',
          'What it calls itself',
          `<input data-cfg="assistantName" value="${str('assistantName')}">`,
        ) +
          row(
            'Your name',
            'How it addresses you',
            `<input data-cfg="userName" value="${str('userName')}" placeholder="how it addresses you">`,
          ) +
          stack(
            'Personality',
            'Layered onto the Claude Code system prompt',
            `<textarea data-cfg="personality" rows="3">${str('personality')}</textarea>`,
          ) +
          row(
            'Character card',
            'Import a SillyTavern chara_card_v2',
            `<input type="file" id="card-file" accept="application/json"><span id="card-status" class="set__hint"></span>`,
          ),
      )}

      ${group(
        'Appearance',
        row(
          'Theme',
          'Light, dark, or follow Windows',
          select('theme', cfg['theme'], [
            ['system', 'System'],
            ['light', 'Light'],
            ['dark', 'Dark'],
          ]),
        ),
      )}

      ${group(
        'Model &amp; host',
        row(
          'Voice engine',
          'Which provider speaks and listens',
          select('voiceProvider', cfg['voiceProvider'], [
            ['gpt-realtime', 'OpenAI Realtime (cloud)'],
            ['local-cascade', 'Local cascade (offline)'],
          ]),
        ) +
          row(
            'Voice model',
            'OpenAI Realtime model',
            select('openaiModel', cfg['openaiModel'], [
              ['gpt-realtime-mini', 'gpt-realtime-mini'],
              ['gpt-realtime', 'gpt-realtime'],
            ]),
          ) +
          row(
            'Voice context',
            'How much ambient context the voice model gets',
            select('voiceContextLevel', cfg['voiceContextLevel'] ?? 'standard', [
              ['thin', 'Thin — capabilities only'],
              ['standard', 'Standard — + persona &amp; orientation'],
              ['rich', 'Rich — + sprint &amp; memory'],
              ['maximal', 'Maximal — + full environment'],
            ]),
          ) +
          row(
            'Claude host',
            'Where the Claude Code backend runs',
            select('claudeHost', cfg['claudeHost'], [
              ['auto', 'auto'],
              ['windows', 'windows'],
              ['wsl', 'wsl'],
            ]),
          ),
      )}

      ${group(
        'Audio',
        row(
          'Microphone',
          'Input device for voice',
          `<select data-cfg="inputDeviceId">${deviceOpts('audioinput', cfg['inputDeviceId'])}</select>`,
        ) +
          row(
            'Speaker',
            'Output device for replies',
            `<select data-cfg="outputDeviceId">${deviceOpts('audiooutput', cfg['outputDeviceId'])}</select>`,
          ),
      )}

      ${group(
        'Workspace',
        row(
          'Project folder',
          'The repo Claude works in by default',
          `<input data-cfg="claudeCwd" value="${str('claudeCwd')}" placeholder="e.g. C:\\code\\amethyst">`,
        ) +
          stack(
            'Repo roots',
            'One folder per line; their subfolders are your projects',
            `<textarea data-cfg="repoRoots" data-cfg-lines rows="2" placeholder="C:\\_repos&#10;\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\repos">${strLines('repoRoots')}</textarea>`,
          ) +
          stack(
            'Environment notes',
            'Anything it should know about your machine and folders',
            `<textarea data-cfg="envNotes" rows="2">${str('envNotes')}</textarea>`,
          ) +
          row(
            'Knowledge vault',
            'Your context2 / claude-obsidian folder',
            `<input data-cfg="vaultPath" value="${str('vaultPath')}" placeholder="path to your vault">`,
          ),
      )}

      ${group(
        'Permissions &amp; hotkeys',
        row(
          'Tool permissions',
          'How file and shell changes are gated',
          select('toolPermissionMode', cfg['toolPermissionMode'] ?? 'gated', [
            ['gated', 'Ask before file/shell changes'],
            ['auto', 'Allow all tools without asking'],
            ['readonly', 'Never allow file/shell changes'],
          ]),
        ) +
          row(
            'Push-to-talk hotkey',
            'Click the field, then press the chord',
            `<input data-cfg="hotkey" data-hotkey readonly value="${str('hotkey')}" placeholder="Click, then press keys">`,
          ) +
          row(
            '&quot;Explain selection&quot; hotkey',
            'Acts on whatever you copied',
            `<input data-cfg="explainHotkey" data-hotkey readonly value="${str('explainHotkey')}" placeholder="Click, then press keys">`,
          ),
      )}

      ${group(
        'Behaviour',
        toggle(
          'wakeWordEnabled',
          'Always-listening wake word',
          'Say its name instead of pressing the hotkey',
        ) +
          toggle(
            'screenAwareness',
            'Let it see my screen',
            'Reads the foreground window when it needs to',
          ) +
          toggle(
            'screenCaptureConsent',
            'Ask before every screenshot',
            'Confirm each capture individually',
          ) +
          toggle(
            'memoryEnabled',
            'Remember things about me',
            'Durable facts and preferences across sessions',
          ) +
          toggle(
            'semanticMemory',
            'Smarter memory search',
            'Local embeddings instead of keyword recall',
          ) +
          toggle('remindersEnabled', 'Allow reminders', 'Scheduled nudges it can set for you') +
          toggle(
            'proactiveEnabled',
            'Proactive heads-ups',
            'Runs watches and speaks up unprompted',
          ) +
          toggle(
            'activityStreamEnabled',
            'Show live activity feed',
            'Stream every tool call to the Activity view',
          ) +
          toggle(
            'activityShowThinking',
            'Include the model&#39;s thinking',
            'Show reasoning alongside tool calls',
          ) +
          toggle(
            'activityAutoOpen',
            'Switch to Activity while working',
            'Jump to the feed when work starts, back when it settles',
          ),
      )}

      ${group(
        'Secrets',
        row(
          'OpenAI API key',
          hasKey
            ? '<span class="set__ok">✓ saved</span> — used for the realtime voice session'
            : '<span class="set__warn">not set</span> — required for cloud voice',
          `<input type="password" id="openai-key" placeholder="sk-..."><button class="btn" id="save-key" type="button">Save</button>`,
        ),
      )}

      <section>
        <div class="set__label set__label--danger">Danger zone</div>
        <div class="set__danger">
          ${info('Clear conversation', 'Permanently removes the current transcript.')}
          <div class="set__danger-actions">
            <button class="btn btn--warn" id="danger-ask" type="button">Clear…</button>
            <button class="btn btn--ghost is-hidden" id="danger-cancel" type="button">Cancel</button>
            <button class="btn btn--danger is-hidden" id="danger-now" type="button">Clear now</button>
          </div>
        </div>
      </section>

      <p id="settings-status" class="set__status"></p>
    `;
  }

  private wire(): void {
    // Text/select/textarea → setConfig on change (hotkey fields handled separately).
    this.el.querySelectorAll<HTMLElement>('[data-cfg]').forEach((node) => {
      if (node.hasAttribute('data-hotkey')) return;
      const key = node.dataset.cfg!;
      const input = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      const isCheckbox = input instanceof HTMLInputElement && input.type === 'checkbox';
      const isLines = node.hasAttribute('data-cfg-lines');
      input.addEventListener('change', () => {
        const value = isCheckbox
          ? (input as HTMLInputElement).checked
          : isLines
            ? input.value
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean)
            : input.value;
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

    this.wireDangerZone();
  }

  /** Two-step clear: "Clear…" arms it, then Cancel / Clear now. */
  private wireDangerZone(): void {
    const ask = this.el.querySelector<HTMLElement>('#danger-ask');
    const cancel = this.el.querySelector<HTMLElement>('#danger-cancel');
    const now = this.el.querySelector<HTMLElement>('#danger-now');
    if (!ask || !cancel || !now) return;
    const arm = (armed: boolean) => {
      ask.classList.toggle('is-hidden', armed);
      cancel.classList.toggle('is-hidden', !armed);
      now.classList.toggle('is-hidden', !armed);
    };
    ask.addEventListener('click', () => arm(true));
    cancel.addEventListener('click', () => arm(false));
    now.addEventListener('click', () => {
      arm(false);
      this.onClearConversation?.();
      this.status('Conversation cleared.');
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
