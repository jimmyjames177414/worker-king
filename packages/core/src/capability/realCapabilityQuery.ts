import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CapabilityQueryFn } from './CapabilityManifest.js';

/**
 * The real capability query fn, backed by the SDK's `query`. Isolated here so the
 * CapabilityManifest unit (and its tests) never import SDK values — only types.
 * The SDK `Query` structurally satisfies CapabilityQueryHandle.
 */
export const realCapabilityQueryFn: CapabilityQueryFn = (params) =>
  query(params) as unknown as ReturnType<CapabilityQueryFn>;
