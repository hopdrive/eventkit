// =============================================================================
// eventkit/plugins/batch
// =============================================================================
// Durability plugin (§12, ADR-015/020). Durability is EMERGENT from registering
// this plugin — there is NO core `durable` flag. Registered only in the
// db-batchjobs function; `requires: ['source:hasura']`. The job stays
// batch-unaware:
//   1. `augmentJobContext` injects the triggering `batch_jobs` row's `input` as
//      the baseline `ctx.input` (handler input merges on top — ADR-020).
//   2. lifecycle hooks transition the row (processing → done/error/timeout),
//      persisting `output` (with logs + error + result FOLDED IN), self-correlating
//      the row id from the envelope.
//
// SCHEMA ALIGNMENT (parity): the real `batch_jobs` table has `status`, `output`
// (jsonb), `updatedat`, plus `delay_ms`/`delay_key`/`trigger_type`/`batch_id`/
// `sequence`/`input`. It has NO started_at/completed_at/attempt/error/logs columns,
// so this plugin writes ONLY `status` + `output` and folds logs/error/result into
// `output` (matching the legacy batchJobUtils.updateBatchJobStatus). The store
// adapter owns the `updatedat: now()` stamp.
//
// DURABLE DELAYED RETRY (opt-in): core's `options.retries` are FAST, in-process,
// transient retries that die with the process. For CRASH-SURVIVING retries,
// configure `durableRetry`; on a failed job the plugin schedules a NEW delayed
// `batch_jobs` row via `store.enqueueDelayed` (delay_ms + delay_key dedup), exactly
// like the legacy `createDelayedBatchJob`. Off by default (no behavior change).
import type { EventKitPlugin, JobContext, JobExecution, LogEntry } from '../../core/index.js';
import { assertSerializableMetadata, stripNonSerializable } from '../../core/index.js';
import { getNewRow, getOldRow } from '../hasura-shared/payload.js';

/** Lifecycle states of a `batch_jobs` row (§12.1). */
export type BatchJobStatus = 'pending' | 'ready' | 'delaying' | 'processing' | 'done' | 'error' | 'timeout';

/** The only columns this plugin writes (the store adds `updatedat`). */
export interface BatchJobUpdate {
  status?: BatchJobStatus;
  output?: unknown;
}

/** Spec for a durable delayed retry row (ports legacy createDelayedBatchJob). */
export interface DelayedBatchJobSpec {
  triggerType: string;
  /** Dedup key; the store forms `delay_key = ${triggerType}-${uniqueKey}` (unique while pending/delaying). */
  uniqueKey: string;
  delayMs: number;
  sequence?: number;
  input?: unknown;
  user?: string;
}

/** Generic persistence adapter. HopDrive wires a GraphQL-backed store. */
export interface BatchJobStore {
  /** Update the triggering row's status/output (and stamp updatedat). */
  update(id: string | number, fields: BatchJobUpdate): void | Promise<void>;
  /** Insert a delayed retry row (delay_ms/delay_key dedup). Required only if `durableRetry` is configured. */
  enqueueDelayed?(spec: DelayedBatchJobSpec): void | Promise<void>;
}

export interface BatchConfig {
  store: BatchJobStore;
  /** End-of-job flush is always on. These add periodic flushing for the live-watch UI (§12.6). */
  logFlush?: {
    intervalMs?: number;
    everyNEntries?: number;
  };
  /**
   * Opt-in durable, crash-surviving retry. On a failed job, schedule a delayed
   * `batch_jobs` row (dedup honored) carrying the same input + an incremented
   * attempt counter, up to `maxAttempts`.
   */
  durableRetry?: {
    delayMs: number;
    maxAttempts: number;
    /** Trigger type for the retry row; defaults to the triggering row's `trigger_type`. */
    triggerType?: string;
    user?: string;
  };
}

type RowId = string | number;
const RETRY_ATTEMPT_KEY = '__retryAttempt';

interface TriggeringRow {
  id: RowId;
  input: unknown;
  triggerType?: string;
  sequence?: number;
  delayKey?: string;
}

const rowFor = (ctx: JobContext): TriggeringRow | undefined => {
  const payload = ctx.envelope.payload;
  const row = (getNewRow(payload as never) ?? getOldRow(payload as never)) as
    | { id?: RowId; input?: unknown; trigger_type?: string; sequence?: number; delay_key?: string }
    | null;
  if (!row || row.id === undefined || row.id === null) return undefined;
  const out: TriggeringRow = { id: row.id, input: row.input };
  if (row.trigger_type !== undefined) out.triggerType = row.trigger_type;
  if (row.sequence !== undefined) out.sequence = row.sequence;
  if (row.delay_key !== undefined) out.delayKey = row.delay_key;
  return out;
};

const serializeError = (err: JobExecution['error']): unknown =>
  err ? { name: err.name, message: err.message, ...(err.code ? { code: err.code } : {}) } : undefined;

export function batch(config: BatchConfig): EventKitPlugin {
  if (!config?.store || typeof config.store.update !== 'function') {
    throw new Error('batch() requires a `store` with an `update(id, fields)` method.');
  }
  const { store, durableRetry } = config;
  const everyNEntries = config.logFlush?.everyNEntries;
  const intervalMs = config.logFlush?.intervalMs;

  const buffers = new Map<RowId, LogEntry[]>();
  const timers = new Map<RowId, ReturnType<typeof setInterval>>();

  const safeUpdate = async (id: RowId, fields: BatchJobUpdate): Promise<void> => {
    try {
      await store.update(id, fields);
    } catch {
      // best-effort: a durability write failure must not fail the job
    }
  };

  // Strip live infrastructure clients (sdk/Apollo/graphql-request) + circular refs before
  // persisting, so a job that returns something holding a live client degrades gracefully
  // instead of corrupting the write (D13).
  const scrub = (v: unknown): unknown => stripNonSerializable(v);

  /** Build the `output` jsonb: the job's result + accumulated logs + error, folded into one object. */
  const composeOutput = (id: RowId, result?: unknown, error?: unknown): unknown => {
    const logs = buffers.get(id) ?? [];
    const output: Record<string, unknown> = {};
    if (result !== undefined) output['result'] = scrub(result);
    if (logs.length) output['logs'] = scrub(logs);
    if (error !== undefined) output['error'] = error;
    return output;
  };

  const flushLogs = async (id: RowId): Promise<void> => {
    const logs = buffers.get(id);
    if (!logs || logs.length === 0) return;
    await safeUpdate(id, { status: 'processing', output: { logs: scrub(logs) } });
  };

  const stopTimer = (id: RowId): void => {
    const t = timers.get(id);
    if (t) {
      clearInterval(t);
      timers.delete(id);
    }
  };

  const scheduleDurableRetry = async (row: TriggeringRow): Promise<boolean> => {
    if (!durableRetry || typeof store.enqueueDelayed !== 'function') return false;
    const input = (row.input && typeof row.input === 'object' ? (row.input as Record<string, unknown>) : {}) as Record<string, unknown>;
    const attempt = typeof input[RETRY_ATTEMPT_KEY] === 'number' ? (input[RETRY_ATTEMPT_KEY] as number) : 0;
    if (attempt >= durableRetry.maxAttempts) return false;
    const triggerType = durableRetry.triggerType ?? row.triggerType;
    if (!triggerType) return false;
    const spec: DelayedBatchJobSpec = {
      triggerType,
      uniqueKey: row.delayKey ?? String(row.id),
      delayMs: durableRetry.delayMs,
      input: { ...input, [RETRY_ATTEMPT_KEY]: attempt + 1 },
      ...(row.sequence !== undefined ? { sequence: row.sequence } : {}),
      ...(durableRetry.user ? { user: durableRetry.user } : {}),
    };
    try {
      await store.enqueueDelayed(spec);
      return true;
    } catch {
      // dedup (uniqueness violation) or transport error → fall through to 'error'
      return false;
    }
  };

  return {
    name: 'batch',
    requires: ['source:hasura'],

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
      // Fail-fast BEFORE the first persist (D13): job metadata MUST be JSON-serializable.
      // A non-serializable value (a live client, a closure) throws NAMING the key — routed
      // to onError as a loud breadcrumb rather than silently mangled at write time.
      assertSerializableMetadata(ctx.job.metadata, `job('${String(ctx.job.name)}').metadata`);
      buffers.set(row.id, []);
      if (intervalMs && intervalMs > 0) {
        const timer = setInterval(() => void flushLogs(row.id), intervalMs);
        if (typeof timer.unref === 'function') timer.unref();
        timers.set(row.id, timer);
      }
      await safeUpdate(row.id, { status: 'processing' });
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

      if (execution.status === 'completed') {
        await safeUpdate(row.id, { status: 'done', output: composeOutput(row.id, execution.output) });
      } else if (execution.status === 'timed_out' || execution.status === 'cancelled') {
        await safeUpdate(row.id, { status: 'timeout', output: composeOutput(row.id, undefined, serializeError(execution.error)) });
      } else {
        // failed: try a durable delayed retry. A row with a LIVE retry MUST NOT read as
        // terminally dead (§12.4 / P0-4) — an operator (and the live batch_jobs watch view)
        // has to tell "retrying" from "failed for good." When a follow-up attempt was
        // scheduled, this row reads as a non-terminal retry state ('delaying'); terminal
        // 'error' is reserved for the exhausted case (no further retry). This matches legacy
        // @hopdrive/batch, where the delay_key-deduped follow-up row carries the next attempt.
        const retryScheduled = await scheduleDurableRetry(row);
        const status: BatchJobStatus = retryScheduled ? 'delaying' : 'error';
        await safeUpdate(row.id, { status, output: composeOutput(row.id, undefined, serializeError(execution.error)) });
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
