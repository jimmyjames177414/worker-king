import { createRequire } from 'node:module';
import type { RuntimeFeatures } from '@workerking/shared';

/**
 * Runtime feature probes — which optional packages this daemon can actually reach.
 *
 * Two settings depend on packages that are NOT installed by default: semantic
 * memory recall (`@huggingface/transformers`) and the offline cascade voice
 * engine (vad-web + transformers + kokoro). Without them the code degrades
 * quietly — semantic recall falls back to keyword, cascade voice simply breaks —
 * and the settings toggle keeps rendering as if it worked. Probing here lets the
 * UI disable the control and say why instead.
 *
 * Resolution (not import) is the probe: it answers "is this package present"
 * without paying to load a multi-megabyte ML runtime. It is evaluated against
 * the DAEMON's module graph, so a package installed only into `packages/app`
 * reads as unavailable here — install optional deps at the workspace root (or
 * into `@workerking/core`) if this probe should see them.
 */

const requireFrom = createRequire(import.meta.url);

/** Local sentence-embedding model behind semantic memory recall. */
export const SEMANTIC_MEMORY_PACKAGES = ['@huggingface/transformers'] as const;

/** VAD + STT + TTS behind the offline cascade voice engine. */
export const LOCAL_CASCADE_PACKAGES = [
  '@ricky0123/vad-web',
  '@huggingface/transformers',
  'kokoro-js',
] as const;

/** Every listed package resolves from the daemon's module graph. */
export function packagesResolvable(specs: readonly string[]): boolean {
  return specs.every((spec) => {
    try {
      requireFrom.resolve(spec);
      return true;
    } catch {
      return false;
    }
  });
}

export function localCascadeStatus(): RuntimeFeatures['localCascade'] {
  return packagesResolvable(LOCAL_CASCADE_PACKAGES) ? 'available' : 'unavailable';
}

/**
 * Semantic-memory status. `active` is only claimed when the embedding backend
 * really loaded; with the setting off we fall back to the package probe so the
 * toggle stays usable when it *would* work.
 */
export function semanticMemoryStatus(built?: {
  backend: 'semantic' | 'keyword';
}): RuntimeFeatures['semanticMemory'] {
  if (built?.backend === 'semantic') return 'active';
  return packagesResolvable(SEMANTIC_MEMORY_PACKAGES) ? 'available' : 'unavailable';
}

/** Boot-time defaults, before (or without) a resolved brain. */
export function probeRuntimeFeatures(): RuntimeFeatures {
  return { semanticMemory: semanticMemoryStatus(), localCascade: localCascadeStatus() };
}
