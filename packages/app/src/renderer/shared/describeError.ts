/**
 * Renders any thrown value into a diagnosable string for logging.
 *
 * The renderer's console output only reaches the daemon/app log files as a
 * flattened string (Electron's `webContents.on('console-message', ...)` gives
 * a pre-formatted message, not the original argument objects — see
 * main/index.ts). A plain `console.error(label, err)` is fine for a real
 * `Error` (V8 attaches `.stack`, which Chromium's console formatter prints),
 * but two other shapes are common in this codebase and both degrade to the
 * useless `[object X]`:
 *  - WebIDL exceptions (`DOMException` from `getUserMedia`, `AudioContext`,
 *    WebRTC, etc.) are not `instanceof Error` and carry no `.stack` — but
 *    `.name` (e.g. "NotAllowedError", "NotFoundError", "NotReadableError")
 *    and `.message` are exactly the actionable diagnostic.
 *  - Raw SDK event/error objects (e.g. from `@openai/agents-realtime`) whose
 *    own properties are what's informative, not the constructor name.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  if (err && typeof err === 'object') {
    // DOMException-shaped: name/message live on the prototype as accessors, so
    // JSON.stringify(err) below would otherwise yield "{}".
    const named = err as { name?: unknown; message?: unknown };
    if (typeof named.name === 'string' && typeof named.message === 'string') {
      return `${named.name}: ${named.message}`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}
