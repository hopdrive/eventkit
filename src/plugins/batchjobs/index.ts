// =============================================================================
// @hopdrive/eventkit/plugins/batchjobs
// =============================================================================
// Durability plugin (§12, ADR-015/020). Durability is EMERGENT from registering
// this plugin — there is NO core `durable` flag. Registered only in the
// db-batchjobs function; `requires: ['source:hasura']`. The job stays
// batch-unaware:
//   1. `augmentJobContext` injects the triggering `batch_jobs` row's `input` as
//      the baseline `ctx.input` (handler input merges on top — ADR-020).
//   2. lifecycle hooks transition the row (processing → done/error/timeout),
//      persist output + logs, self-correlating the row id from the envelope.
// Persistence goes through an injected `store` (generic — wire a GraphQL store);
// own write failures are best-effort, never fatal to the job.
import type { EventKitPlugin, JobContext, JobExecution, LogEntry } from '../../core/index.js';
import { replaceCircularReferences, serializeOutput } from '../../core/index.js';
import { getNewRow, getOldRow } from '../../sources/hasura/payload.js';

/** Lifecycle states of a `batch_jobs` row (§12.1). */
export type BatchJobStatus = 'pending' | 'ready' | 'delaying' | 'processing' | 'done' | 'error' | 'timeout';

export interface BatchJobUpdate {
  status?: BatchJobStatus;
  output?: unknown;
  error?: unknown;
  logs?: unknown;
  started_at?: string;
  completed_at?: string;
  attempt?: number;
}

/** Generic persistence adapter. HopDrive wires a GraphQL-backed store. */
export interface BatchJobStore {
  update(id: string | number, fields: BatchJobUpdate): void | Promise<void>;
}

export interface BatchJobsConfig {
  store: BatchJobStore;
  /** End-of-job flush is always on. These add periodic flushing for the live-watch UI (§12.6). */
  logFlush?: {
    intervalMs?: number;
    everyNEntries?: number;
  };
}

type RowId = string | number;

const rowFor = (ctx: JobContext): { id: RowId; input: unknown } | undefined => {
  const payload = ctx.envelope.payload;
  const row = (getNewRow(payload as never) ?? getOldRow(payload as never)) as
    | { id?: RowId; input?: unknown }
    | null;
  if (!row || row.id === undefined || row.id === null) return undefined;
  return { id: row.id, input: row.input };
};

export function batchJobs(config: BatchJobsConfig): EventKitPlugin {
  if (!config?.store || typeof config.store.update !== 'function') {
    throw new Error('batchJobs() requires a `store` with an `update(id, fields)` method.');
  }
  const { store } = config;
  const everyNEntries = config.logFlush?.everyNEntries;
  const intervalMs = config.logFlush?.intervalMs;

  // Per-row log buffers + periodic timers, keyed by batch_jobs row id.
  const buffers = new Map<RowId, LogEntry[]>();
  const timers = new Map<RowId, ReturnType<typeof setInterval>>();

  const safeUpdate = async (id: RowId, fields: BatchJobUpdate): Promise<void> => {
    try {
      await store.update(id, fields);
    } catch {
      // best-effort: a durability write failure must not fail the job
    }
  };

  const flushLogs = async (id: RowId): Promise<void> => {
    const logs = buffers.get(id);
    if (!logs || logs.length === 0) return;
    const snapshot = replaceCircularReferences(logs);
    buffers.set(id, []);
    await safeUpdate(id, { logs: snapshot });
  };

  const stopTimer = (id: RowId): void => {
    const t = timers.get(id);
    if (t) {
      clearInterval(t);
      timers.delete(id);
    }
  };

  return {
    name: 'batchjobs',
    requires: ['source:hasura'],

    // Inject the triggering row's `input` as the job's baseline input.
    augmentJobContext(ctx: JobContext) {
      const row = rowFor(ctx);
      if (row && row.input && typeof row.input === 'object') {
        return { input: row.input as Record<string, unknown> };
      }
      return undefined;
    },

    async onJobStart(ctx: JobContext) {
      const row = rowFor(ctx);
      if (!row) return;
      buffers.set(row.id, []);
      if (intervalMs && intervalMs > 0) {
        const timer = setInterval(() => void flushLogs(row.id), intervalMs);
        if (typeof timer.unref === 'function') timer.unref();
        timers.set(row.id, timer);
      }
      await safeUpdate(row.id, {
        status: 'processing',
        started_at: new Date().toISOString(),
        attempt: ctx.job.attempt,
      });
    },

    onJobLog(ctx: JobContext, entry: LogEntry) {
      const row = rowFor(ctx);
      if (!row) return;
      const logs = buffers.get(row.id) ?? [];
      logs.push(entry);
      buffers.set(row.id, logs);
      if (everyNEntries && logs.length >= everyNEntries) void flushLogs(row.id);
    },

    async onJobEnd(ctx: JobContext, execution: JobExecution) {
      const row = rowFor(ctx);
      if (!row) return;
      stopTimer(row.id);
      await flushLogs(row.id);

      const retryable = execution.status === 'failed' && execution.attempt < execution.maxAttempts;
      if (execution.status === 'completed') {
        await safeUpdate(row.id, {
          status: 'done',
          output: serializeOutput(execution.output),
          completed_at: new Date().toISOString(),
        });
      } else if (execution.status === 'timed_out' || execution.status === 'cancelled') {
        await safeUpdate(row.id, { status: 'timeout', completed_at: new Date().toISOString() });
      } else if (retryable) {
        // core retries in-process; record the interim state + schedule a delayed retry
        await safeUpdate(row.id, { status: 'delaying', attempt: execution.attempt, error: execution.error });
      } else {
        await safeUpdate(row.id, {
          status: 'error',
          error: execution.error,
          completed_at: new Date().toISOString(),
        });
      }
      buffers.delete(row.id);
    },

    async onFlush() {
      for (const id of [...buffers.keys()]) {
        stopTimer(id);
        await flushLogs(id);
      }
    },
  };
}
