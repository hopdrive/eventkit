// =============================================================================
// @hopdrive/eventkit/plugins/batchjobs
// =============================================================================
// Durability plugin (§12, ADR-015/020). Durability is EMERGENT from registering
// this plugin — there is no core `durable` flag. Registered only in the
// db-batchjobs function; `requires: ['source:hasura']`. Phase 3 implements it.

import type { EventKitPlugin } from '../../core/index.js';
import { NotImplementedError } from '../../core/index.js';

/** Lifecycle states of a `batch_jobs` row (§12.1). */
export type BatchJobStatus = 'pending' | 'ready' | 'delaying' | 'processing' | 'done' | 'error' | 'timeout';

/** Config for the BatchJobs plugin. End-of-job flush is always on (§12.6). */
export interface BatchJobsConfig {
  graphql: { endpoint: string; adminSecret: string };
  logFlush?: {
    /** Periodic flush cadence (ms) for the live-watch UI. */
    intervalMs?: number;
    /** Or flush after N buffered log entries. */
    everyNEntries?: number;
  };
}

/**
 * BatchJobs plugin factory. Pass to `kit.use(batchJobs, config)`; the kit
 * instantiates it (D22 — lazily). Phase 3 implements the lifecycle persistence.
 */
export function batchJobs(_config: BatchJobsConfig): EventKitPlugin {
  throw new NotImplementedError('batchJobs() — durability plugin lands in Phase 3.');
}
