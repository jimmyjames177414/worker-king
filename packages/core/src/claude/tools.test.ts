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

  it('returns the active window title when enabled', async () => {
    const config = new ConfigStore({ screenAwareness: true });
    const { getActiveWindow } = buildScreenTools({ config, screen: canned });

    const r = await getActiveWindow.handler({}, undefined);
    expect(r.isError).toBeUndefined();
    expect(textOf(r)).toContain('budget.xlsx — Excel');
  });

  it('returns an image content block from capture_screen when enabled', async () => {
    const config = new ConfigStore({ screenAwareness: true });
    const { captureScreen } = buildScreenTools({ config, screen: canned });

    const r = await captureScreen.handler({ target: 'screen' }, undefined);
    const image = r.content.find((c) => c.type === 'image') as
      | { type: 'image'; data: string; mimeType: string }
      | undefined;
    expect(image).toBeDefined();
    expect(image?.mimeType).toBe('image/png');
    expect(image?.data).toBe('ZmFrZS1wbmc=');
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
    ]);
  });
});
