// =============================================================================
// @hopdrive/eventkit/plugins/observability
// =============================================================================
// First-class observability plugin (§13). Buffers per-invocation and flushes at
// onInvocationEnd/onFlush — NEVER a synchronous network write per job on the hot
// path. Records the Invocation → Event → Job hierarchy. Phase 3 implements it.

import type { EventKitPlugin } from '../../core/index.js';
import { NotImplementedError } from '../../core/index.js';

export interface ObservabilityConfig {
  graphql: { endpoint: string; adminSecret: string };
  /** Best-effort by default; opt into failing the invocation on write failure. */
  strict?: boolean;
}

/**
 * Observability plugin factory. Pass to `kit.use(observability, config)`.
 * Phase 3 implements the buffered transport.
 */
export function observability(_config: ObservabilityConfig): EventKitPlugin {
  throw new NotImplementedError('observability() — plugin lands in Phase 3.');
}
