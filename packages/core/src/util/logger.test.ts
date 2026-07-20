import { describe, it, expect } from 'vitest';
import { createLogger } from './logger.js';

function capture(opts: Parameters<typeof createLogger>[0] = {}) {
  const lines: string[] = [];
  const log = createLogger({
    now: () => new Date('2026-07-15T00:00:00.000Z'),
    sink: (l) => lines.push(l),
    ...opts,
  });
  return { log, lines };
}

describe('createLogger', () => {
  it('formats level, timestamp, scope, and message', () => {
    const { log, lines } = capture({ scope: 'daemon' });
    log.info('listening', { port: 4100 });
    expect(lines[0]).toBe('2026-07-15T00:00:00.000Z INFO  [daemon] listening {"port":4100}');
  });

  it('suppresses below the threshold level', () => {
    const { log, lines } = capture({ level: 'warn' });
    log.info('ignored');
    log.debug('ignored too');
    log.warn('kept');
    log.error('kept');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('kept');
  });

  it('emits one JSON object per line when json is on', () => {
    const { log, lines } = capture({ scope: 'x', json: true });
    log.error('boom', { code: 42 });
    expect(JSON.parse(lines[0])).toEqual({
      ts: '2026-07-15T00:00:00.000Z',
      level: 'error',
      scope: 'x',
      msg: 'boom',
      code: 42,
    });
  });

  it('child() extends the scope and inherits settings', () => {
    const { log, lines } = capture({ scope: 'root' });
    log.child('tool').info('call');
    expect(lines[0]).toContain('[root:tool]');
  });

  it('omits the meta suffix when there is no meta', () => {
    const { log, lines } = capture({ scope: 's' });
    log.info('plain');
    expect(lines[0]).toBe('2026-07-15T00:00:00.000Z INFO  [s] plain');
  });
});
