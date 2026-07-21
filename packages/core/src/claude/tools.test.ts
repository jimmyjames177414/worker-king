import { describe, it, expect } from 'vitest';
import { buildScreenTools, WORKERKING_TOOL_ALLOWLIST } from './tools.js';
import { ConfigStore } from '../config/ConfigStore.js';
import { FakeScreenContextProvider } from '../screen/ScreenContextProvider.js';

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

describe('screen-awareness tools', () => {
  const canned = new FakeScreenContextProvider({
    ok: true,
    activeWindowTitle: 'budget.xlsx — Excel',
    imageBase64: 'ZmFrZS1wbmc=',
  });

  it('refuses when screenAwareness is off (default)', async () => {
    const config = new ConfigStore();
    const { getActiveWindow, captureScreen } = buildScreenTools({ config, screen: canned });

    const r1 = await getActiveWindow.handler({}, undefined);
    expect(r1.isError).toBe(true);
    expect(textOf(r1)).toMatch(/turned OFF/i);

    const r2 = await captureScreen.handler({ target: 'window' }, undefined);
    expect(r2.isError).toBe(true);
  });

  it('returns the active window title when enabled, fenced as untrusted (N5)', async () => {
    const config = new ConfigStore({ screenAwareness: true });
    const { getActiveWindow } = buildScreenTools({ config, screen: canned });

    const r = await getActiveWindow.handler({}, undefined);
    expect(r.isError).toBeUndefined();
    const text = textOf(r);
    expect(text).toContain('budget.xlsx — Excel');
    // Screen-derived content is wrapped so the model treats it as data, not commands.
    expect(text).toContain('untrusted-external-data');
  });

  it('returns an image content block from capture_screen when enabled', async () => {
    const config = new ConfigStore({ screenAwareness: true });
    const { captureScreen } = buildScreenTools({ config, screen: canned });

    const r = await captureScreen.handler({ target: 'screen' }, undefined);
    const image = r.content.find((c) => c.type === 'image') as
      { type: 'image'; data: string; mimeType: string } | undefined;
    expect(image).toBeDefined();
    expect(image?.mimeType).toBe('image/png');
    expect(image?.data).toBe('ZmFrZS1wbmc=');
  });

  it('requires consent before a screenshot when screenCaptureConsent is on (N15)', async () => {
    const config = new ConfigStore({ screenAwareness: true, screenCaptureConsent: true });
    const denied = await buildScreenTools({
      config,
      screen: canned,
      confirmCapture: async () => false,
    }).captureScreen.handler({ target: 'screen' }, undefined);
    expect(denied.isError).toBe(true);
    expect(textOf(denied)).toMatch(/declined/i);

    const approved = await buildScreenTools({
      config,
      screen: canned,
      confirmCapture: async () => true,
    }).captureScreen.handler({ target: 'screen' }, undefined);
    expect(approved.content.some((c) => c.type === 'image')).toBe(true);
  });

  it('fails closed when consent is on but no confirmer is wired (N15)', async () => {
    const config = new ConfigStore({ screenAwareness: true, screenCaptureConsent: true });
    const r = await buildScreenTools({ config, screen: canned }).captureScreen.handler(
      { target: 'screen' },
      undefined,
    );
    expect(r.isError).toBe(true);
  });

  it('audits every call', async () => {
    const config = new ConfigStore({ screenAwareness: true });
    const events: string[] = [];
    const { getActiveWindow } = buildScreenTools({
      config,
      screen: canned,
      audit: (e) => events.push(e.tool),
    });
    await getActiveWindow.handler({}, undefined);
    expect(events).toContain('get_active_window');
  });

  it('surfaces a capture failure as a tool error', async () => {
    const config = new ConfigStore({ screenAwareness: true });
    const failing = new FakeScreenContextProvider({ ok: false, error: 'No main connected' });
    const { getActiveWindow } = buildScreenTools({ config, screen: failing });
    const r = await getActiveWindow.handler({}, undefined);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('No main connected');
  });

  it('exposes a stable allowlist', () => {
    expect(WORKERKING_TOOL_ALLOWLIST).toEqual([
      'mcp__workerking__get_active_window',
      'mcp__workerking__capture_screen',
      'mcp__workerking__get_standup_state',
      'mcp__workerking__get_standup_diff',
      'mcp__workerking__remember',
      'mcp__workerking__recall',
      'mcp__workerking__list_memories',
      'mcp__workerking__notify',
      'mcp__workerking__set_reminder',
    ]);
  });
});
