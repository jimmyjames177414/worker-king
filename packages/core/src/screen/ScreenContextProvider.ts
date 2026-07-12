import type { WsServer } from '../ws/server.js';
import { daemonEnvelopeContext } from '../util/ids.js';
import { makeEnvelope, isKind, type WsEnvelope } from '@workerking/shared';

/**
 * ScreenContextProvider — supplies WorkerKing's "eyes".
 *
 * Actual capture happens in Electron main (Windows `desktopCapturer` + foreground
 * window title), even when the daemon runs in WSL — so the daemon asks main over
 * the WS bus. This interface lets the screen-awareness Claude tools stay testable
 * headless: a FakeScreenContextProvider returns canned data with no Electron.
 */
export interface ScreenCaptureRequest {
  target: 'window' | 'screen';
  includeImage: boolean;
}

export interface ScreenContext {
  ok: boolean;
  activeWindowTitle?: string;
  /** Raw base64 PNG (no data: prefix), ready for an MCP image content block. */
  imageBase64?: string;
  error?: string;
}

export interface ScreenContextProvider {
  capture(req: ScreenCaptureRequest): Promise<ScreenContext>;
}

/** Deterministic provider for tests / headless runs (no Electron main present). */
export class FakeScreenContextProvider implements ScreenContextProvider {
  constructor(private readonly canned: ScreenContext) {}
  async capture(): Promise<ScreenContext> {
    return this.canned;
  }
}

/**
 * Real provider: round-trips a `screen.capture_request` to the connected Electron
 * main client and awaits its `screen.capture_result`. Times out gracefully if main
 * isn't connected (e.g. the daemon is running standalone/headless).
 */
export class WsScreenContextProvider implements ScreenContextProvider {
  constructor(
    private readonly server: WsServer,
    private readonly timeoutMs = 5000,
  ) {}

  async capture(req: ScreenCaptureRequest): Promise<ScreenContext> {
    const main = this.server.findClient((c) => c.role === 'main');
    if (!main) {
      return { ok: false, error: 'No Electron main connected to capture the screen.' };
    }

    const request = makeEnvelope(daemonEnvelopeContext, 'screen.capture_request', {
      target: req.target,
      includeImage: req.includeImage,
    });

    return new Promise<ScreenContext>((resolve) => {
      const timer = setTimeout(() => {
        dispose();
        resolve({ ok: false, error: 'Screen capture timed out.' });
      }, this.timeoutMs);

      const dispose = this.server.onceReply(request.id, (reply: WsEnvelope) => {
        clearTimeout(timer);
        if (isKind(reply, 'screen.capture_result')) {
          const p = reply.payload;
          resolve({
            ok: p.ok,
            activeWindowTitle: p.activeWindowTitle,
            imageBase64: p.imageDataUrl ? stripDataUrl(p.imageDataUrl) : undefined,
            error: p.error,
          });
        } else {
          resolve({ ok: false, error: 'Unexpected reply to screen capture.' });
        }
      });

      main.raw.send(JSON.stringify(request));
    });
  }
}

function stripDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}
