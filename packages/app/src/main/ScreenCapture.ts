import { desktopCapturer, screen } from 'electron';
import type { PayloadOf } from '@workerking/shared';

/**
 * Screen capture for WorkerKing's "eyes" — runs in Electron main (the Windows GUI
 * process). Returns a foreground-window title and/or a PNG screenshot in response
 * to a `screen.capture_request` from the daemon.
 *
 * Foreground-window detail is best-effort via `desktopCapturer` window sources
 * (Electron doesn't expose the OS foreground window directly). A native module
 * like `active-win` can be dropped in later for an exact active-window title;
 * the daemon-side contract does not change.
 */
export async function captureScreen(
  req: PayloadOf<'screen.capture_request'>,
): Promise<PayloadOf<'screen.capture_result'>> {
  try {
    const primary = screen.getPrimaryDisplay();
    const { width, height } = primary.size;

    const types: Array<'screen' | 'window'> =
      req.target === 'window' ? ['window', 'screen'] : ['screen'];

    const sources = await desktopCapturer.getSources({
      types,
      thumbnailSize: req.includeImage
        ? { width: Math.min(width, 1920), height: Math.min(height, 1080) }
        : { width: 0, height: 0 },
    });

    // Prefer a window source for the title when target === 'window'.
    const windowSource = sources.find((s) => s.id.startsWith('window:'));
    const screenSource = sources.find((s) => s.id.startsWith('screen:'));
    const chosen =
      req.target === 'window' ? (windowSource ?? screenSource) : (screenSource ?? sources[0]);

    if (!chosen) {
      return { ok: false, error: 'No capturable source found.' };
    }

    const activeWindowTitle = windowSource?.name;
    let imageDataUrl: string | undefined;
    if (req.includeImage && !chosen.thumbnail.isEmpty()) {
      imageDataUrl = chosen.thumbnail.toDataURL();
    }

    return { ok: true, activeWindowTitle, imageDataUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
