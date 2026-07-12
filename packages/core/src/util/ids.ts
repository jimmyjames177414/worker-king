import { randomUUID } from 'node:crypto';
import type { EnvelopeContext } from '@workerking/shared';

/**
 * The daemon's EnvelopeContext: real UUIDs and wall-clock time.
 *
 * The shared package stays environment-agnostic (no crypto/Date imports) so the
 * same protocol code runs in the renderer; each process supplies its own context.
 */
export const daemonEnvelopeContext: EnvelopeContext = {
  newId: () => randomUUID(),
  now: () => Date.now(),
};

export function newToken(): string {
  return randomUUID().replace(/-/g, '');
}
