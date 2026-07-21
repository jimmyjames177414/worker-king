/**
 * Renderer-side logging helpers.
 *
 * Renderer console output reaches the log files only through Electron's
 * `webContents.on('console-message', ...)` (see main/index.ts), which hands back
 * a single pre-flattened string — never the original argument objects. So a
 * plain `console.debug('thing', {a: 1})` lands in the log as the useless
 * `thing [object Object]`. Everything diagnostic has to be inlined into the
 * message string itself.
 *
 * The sink in main stamps each line with an ISO timestamp, level and source
 * location, matching the daemon's logger (core/util/logger.ts) so `tail-logs`
 * can interleave the two. What's left for this side is the message body:
 * `[scope] what happened {"meta":"json"}`.
 */

/** Inline a meta object into a log message (see the module note above). */
export function fmt(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}
