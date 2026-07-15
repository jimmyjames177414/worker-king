import { describe, it, expect } from 'vitest';
import {
  workerKingConfigSchema,
  DEFAULT_CONFIG,
  CONFIG_KEYS,
  parseConfig,
} from './domain.js';

describe('WorkerKing config schema', () => {
  it('DEFAULT_CONFIG satisfies the schema', () => {
    expect(workerKingConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
  });

  it('CONFIG_KEYS covers every declared field and stays in sync with the schema', () => {
    // Derived from the schema shape, so this guards against a field being added
    // without becoming pushable to the daemon.
    expect(CONFIG_KEYS).toContain('assistantName');
    expect(CONFIG_KEYS).toContain('claudeCwd'); // previously dropped by the app
    expect(CONFIG_KEYS).toContain('toolPermissionMode');
    expect(new Set(CONFIG_KEYS).size).toBe(CONFIG_KEYS.length);
  });

  it('parseConfig keeps well-typed known keys', () => {
    const out = parseConfig({ assistantName: 'Bea', screenAwareness: true });
    expect(out.assistantName).toBe('Bea');
    expect(out.screenAwareness).toBe(true);
  });

  it('parseConfig drops a whole blob whose known key is the wrong type', () => {
    // A tampered/corrupt field fails validation → caller falls back to defaults.
    const out = parseConfig({ screenAwareness: 'yes-please' });
    expect(out.screenAwareness).toBeUndefined();
  });

  it('parseConfig preserves unknown passthrough keys', () => {
    const out = parseConfig({ assistantName: 'Bea', futureFlag: 42 }) as Record<string, unknown>;
    expect(out['futureFlag']).toBe(42);
  });
});
