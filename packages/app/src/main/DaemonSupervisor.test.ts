import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { DaemonSupervisor, type SpawnFn, toWslPath } from './DaemonSupervisor.js';

/**
 * A minimal fake child process: stdout/stderr are EventEmitters and we can drive
 * READY / exit from the test. Mirrors the parts of ChildProcess the supervisor uses.
 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  ready(port = 4100): void {
    this.stdout.emit(
      'data',
      Buffer.from(`WORKERKING_READY {"port":${port},"token":"tok","host":"windows"}\n`),
    );
  }
  crash(code = 1): void {
    this.emit('exit', code);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

/** Build a supervisor whose spawn hands each new child back to the test. */
function makeSupervisor(overrides: Record<string, unknown> = {}) {
  const children: FakeChild[] = [];
  const delays: number[] = [];
  let clock = 0;
  const spawnFn: SpawnFn = () => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ReturnType<SpawnFn>;
  };
  const sup = new DaemonSupervisor({
    mode: 'windows',
    spawnFn,
    now: () => clock,
    delayFn: async (ms) => {
      delays.push(ms);
      clock += ms; // advance the virtual clock by the backoff we "waited"
    },
    backoffBaseMs: 100,
    backoffMaxMs: 1000,
    maxRestarts: 3,
    restartWindowMs: 10_000,
    healthyUptimeMs: 5_000,
    ...overrides,
  });
  return { sup, children, delays, tick: (ms: number) => (clock += ms), setClock: (v: number) => (clock = v) };
}

describe('DaemonSupervisor crash handling', () => {
  it('resolves start() on the READY handshake', async () => {
    const { sup, children } = makeSupervisor();
    const startP = sup.start();
    children[0].ready(4321);
    const conn = await startP;
    expect(conn).toEqual({ port: 4321, token: 'tok', host: 'windows' });
  });

  it('restarts with exponential backoff on crash', async () => {
    const { sup, children, delays } = makeSupervisor();
    const backoffs: number[] = [];
    sup.on('backoff', ({ delayMs }: { delayMs: number }) => backoffs.push(delayMs));

    const startP = sup.start();
    children[0].ready();
    await startP;

    // First crash → backoff 100, respawn (children[1]); ready it.
    children[0].crash();
    await new Promise((r) => setTimeout(r, 0));
    expect(children).toHaveLength(2);
    children[1].ready();
    await new Promise((r) => setTimeout(r, 0));

    // Second crash → backoff 200.
    children[1].crash();
    await new Promise((r) => setTimeout(r, 0));
    expect(children).toHaveLength(3);

    expect(backoffs).toEqual([100, 200]);
    expect(delays).toEqual([100, 200]);
  });

  it('gives up and emits fatal after exceeding the restart budget', async () => {
    const { sup, children } = makeSupervisor({ maxRestarts: 2 });
    let fatal: Error | undefined;
    sup.on('fatal', (err: Error) => (fatal = err));

    const startP = sup.start();
    children[0].ready();
    await startP;

    // Crash repeatedly without the restarts ever staying healthy.
    for (let i = 0; i < 5; i++) {
      children[children.length - 1].crash();
      await new Promise((r) => setTimeout(r, 0));
      // Re-ready any freshly spawned child so it reaches READY before the next crash.
      children[children.length - 1].ready();
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(fatal).toBeInstanceOf(Error);
    expect(fatal?.message).toMatch(/giving up/);
    // maxRestarts=2 → at most 2 respawns beyond the original before giving up.
    expect(children.length).toBeLessThanOrEqual(3);
  });

  it('does not restart after stop()', async () => {
    const { sup, children } = makeSupervisor();
    const startP = sup.start();
    children[0].ready();
    await startP;

    sup.stop();
    children[0].crash();
    await new Promise((r) => setTimeout(r, 0));
    expect(children).toHaveLength(1); // no respawn
    expect(children[0].killed).toBe(true);
  });

  it('resets the restart counter after a healthy run', async () => {
    const { sup, children, tick } = makeSupervisor({ maxRestarts: 2, healthyUptimeMs: 5_000 });
    let fatal: Error | undefined;
    sup.on('fatal', (err: Error) => (fatal = err));

    const startP = sup.start();
    children[0].ready();
    await startP;

    // Two quick crashes (uses up the budget), each restart readied immediately.
    for (let i = 0; i < 2; i++) {
      children[children.length - 1].crash();
      await new Promise((r) => setTimeout(r, 0));
      // Simulate a long healthy uptime before readying so the counter resets.
      tick(6_000);
      children[children.length - 1].ready();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(fatal).toBeUndefined(); // healthy uptime kept it under budget
  });
});

describe('toWslPath', () => {
  it('maps a Windows path to /mnt', () => {
    expect(toWslPath('C:\\Users\\a\\core.js')).toBe('/mnt/c/Users/a/core.js');
  });
});
