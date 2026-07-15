/**
 * A tiny structured logger for the daemon.
 *
 * Replaces ad-hoc `process.stderr.write("[workerking] …")` with leveled,
 * timestamped, optionally-JSON output. It writes to stderr by default, so the
 * existing `installFileLog` tee still captures everything (including under an F5
 * debug session). Levels gate on a threshold from `WORKERKING_LOG_LEVEL`; set
 * `WORKERKING_LOG_JSON=1` for one JSON object per line (log shipping).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  /** Derive a logger with an extended scope (e.g. root.child('tool')). */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  scope?: string;
  /** Minimum level to emit. Defaults to WORKERKING_LOG_LEVEL or 'info'. */
  level?: LogLevel;
  /** One JSON object per line instead of text. Defaults to WORKERKING_LOG_JSON. */
  json?: boolean;
  /** Where lines go. Defaults to stderr (so installFileLog tees them). */
  sink?: (line: string) => void;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

function envLevel(): LogLevel | undefined {
  const v = process.env.WORKERKING_LOG_LEVEL?.toLowerCase();
  return v && v in ORDER ? (v as LogLevel) : undefined;
}

function envJson(): boolean {
  const v = process.env.WORKERKING_LOG_JSON?.toLowerCase();
  return v === '1' || v === 'true';
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const scope = opts.scope ?? 'workerking';
  const threshold = ORDER[opts.level ?? envLevel() ?? 'info'];
  const json = opts.json ?? envJson();
  const sink = opts.sink ?? ((line: string) => void process.stderr.write(line + '\n'));
  const now = opts.now ?? (() => new Date());

  const emit = (level: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (ORDER[level] < threshold) return;
    const ts = now().toISOString();
    if (json) {
      sink(JSON.stringify({ ts, level, scope, msg: message, ...meta }));
    } else {
      const suffix = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      sink(`${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${suffix}`);
    }
  };

  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (child) => createLogger({ ...opts, scope: `${scope}:${child}` }),
  };
}
