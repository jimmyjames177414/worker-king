import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * When `WORKERKING_LOG_FILE` is set, mirror everything the daemon writes to
 * stdout/stderr into that file (append). This gives a log tailer a live view of
 * the daemon — including under an F5 debug session, where console output would
 * otherwise only reach the VS Code Debug Console and never a file Claude can read.
 *
 * Opt-in via env so packaged/production runs never create stray files; every dev
 * entry point (the `scripts/*.ps1` runners, the VS Code tasks, and launch.json)
 * sets the variable. Best-effort — logging must never crash the daemon.
 */
export function installFileLog(): void {
  const file = process.env.WORKERKING_LOG_FILE;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `\n===== daemon start ${new Date().toISOString()} (pid ${process.pid}) =====\n`);
    teeStream(process.stdout, file);
    teeStream(process.stderr, file);
  } catch {
    // logging is best-effort; ignore setup failures
  }
}

/** Wrap a stream's `write` so every chunk is also appended to `file`. */
function teeStream(stream: NodeJS.WriteStream, file: string): void {
  const orig = stream.write.bind(stream);
  const tee = (chunk: unknown, ...rest: unknown[]): boolean => {
    try {
      appendFileSync(file, typeof chunk === 'string' ? chunk : String(chunk));
    } catch {
      // never let a logging failure break the daemon
    }
    return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
  };
  stream.write = tee as typeof stream.write;
}
