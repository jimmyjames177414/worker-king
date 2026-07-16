import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Write JSON durably: serialize to a sibling temp file, then rename over the
 * target. Rename is atomic on the same filesystem, so a crash/power-loss
 * mid-write can never leave a truncated file behind — the store either sees the
 * old contents or the new ones, never garbage. Every file-backed store should
 * use this instead of a bare writeFileSync (a torn write silently destroys the
 * whole store on the next hydrate).
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, path);
}
