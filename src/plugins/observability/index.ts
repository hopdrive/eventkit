// =============================================================================
// eventkit/plugins/observability
// =============================================================================
// First-class observability (§13). A PURE lifecycle observer that buffers an
// Invocation → Event → Job record hierarchy per invocation and flushes it via an
// injected `sink`. It MUST NOT do a synchronous network write per job on the hot
// path — records buffer and flush at onInvocationEnd (and optionally periodically,
// for the live Console view of long-running invocations). Generic: the transport
// (the built-in `graphqlSink`, or any custom one) is the consumer's `sink`, not
// baked in (ADR-024). Best-effort by default; a failed flush does not fail
// business execution unless `strict` is set.
//
// Source attributes (table/operation/user/…) are read from `envelope.meta` (the
// SourceMeta convention) — the plugin never parses a source-specific payload.
import type {
  DetectorContext,
  ErrorContext,
  EventKitPlugin,
  HandlerContext,
  InvocationContext,
  InvocationResult,
  JobContext,
  JobExecution,
  SourceMeta,
} from '../../core/index.js';
import { safeSerialize } from './serialize.js';

// Re-export the built-in GraphQL sink so the plugin + its default sink import from
// ONE path: `import { observability, graphqlSink } from 'eventkit/plugins/observability'`.
// (Also available standalone at `eventkit/plugins/observability/graphql-sink`.)
export { graphqlSink, type GraphqlSinkConfig, type StatusMap } from './graphql-sink.js';

const newId = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `obs-${Date.now().toString(36)}-${Math.round(performance.now())}`;

// ── Record shapes — mirror the canonical observability schema columns ─────────
export interface InvocationRecord {
  id: string;
  correlation_id: string;
  source_system: string;
  /** Source category ('database' | 'webhook' | 'cron' | …) — drives source-appropriate rendering in the console. */
  source_type?: string;
  source_function?: string;
  source_table?: string;
  source_operation?: string;
  source_event_id?: string;
  source_event_payload?: unknown;
  source_event_time?: string;
  source_user_email?: string;
  source_user_role?: string;
  source_job_id?: string;
  context_data?: unknown;
  status: string;
  created_at: string;
  updated_at: string;
  total_duration_ms?: number;
  events_detected_count: number;
  total_jobs_run: number;
  total_jobs_succeeded: number;
  total_jobs_failed: number;
  error_message?: string;
  error_stack?: string;
}

export interface EventRecord {
  id: string;
  invocation_id: string;
  correlation_id: string;
  event_name: string;
  event_module_path?: string;
  detected: boolean;
  detection_duration_ms?: number;
  detection_error?: string;
  detection_error_stack?: string;
  handler_duration_ms?: number;
  handler_error?: string;
  handler_error_stack?: string;
  jobs_count: number;
  jobs_succeeded: number;
  jobs_failed: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface JobRecord {
  id: string;
  invocation_id: string;
  event_execution_id?: string;
  correlation_id: string;
  job_name: string;
  job_function_name?: string;
  job_options?: unknown;
  duration_ms?: number;
  status: string;
  result?: unknown;
  error_message?: string;
  error_stack?: string;
  created_at: string;
  updated_at: string;
}

export interface ObservabilityBatch {
  invocation: InvocationRecord;
  events: EventRecord[];
  jobs: JobRecord[];
}

export interface ObservabilityConfig {
  /** Flush a per-invocation batch. Wire `graphqlSink(...)` or a custom transport. */
  sink: (batch: ObservabilityBatch) => void | Promise<void>;
  /** When true, a sink failure is rethrown (surfacing via onError); default best-effort. */
  strict?: boolean;
  /**
   * Called when a best-effort sink flush fails (the default, non-`strict` mode). Silent
   * telemetry loss is the worst failure mode for a telemetry system — a partially-written
   * batch can leave a job row stuck `running` after its invocation reads `completed` — so
   * failures are surfaced here instead of being swallowed. Defaults to a `console.warn`.
   * Ignored when `strict` is set (the error is rethrown to `onError` instead).
   */
  onSinkError?: (err: unknown, ctx: { invocationId: string; final: boolean }) => void;
  /** Capture the raw source payload as `source_event_payload`. Default true. */
  captureSourcePayload?: boolean;
  /** Capture serializable job metadata as `job_options`. Default true. */
  captureJobMetadata?: boolean;
  /** Capture error stacks. Default true. */
  captureErrorStacks?: boolean;
  /** Periodic mid-invocation upsert cadence (ms) for the live Console view. Off by default. */
  flushIntervalMs?: number;
  /**
   * Persist each job's `job_execution` row (status `running`) at job START, before the
   * job body runs, rather than only at the next flush/invocation end. Default true.
   *
   * WHY: a job's own DB writes can chain into CHILD invocations (in separate processes)
   * that reference this job as their `source_job_id`. If the job row isn't durable yet,
   * that FK fails and the sink drops the link (graceful-degrade) — orphaning the child as
   * a false second "origin". The runtime awaits onJobStart before the job body, so an
   * eager persist here guarantees the parent job row exists before its side effects fire.
   * Set false only for perf-sensitive telemetry where lineage accuracy is not required.
   */
  persistJobsAtStart?: boolean;
  /**
   * Record an event row for EVERY detector evaluation, including those that did not
   * fire (`detected: false`, status `not_detected`) — matching the legacy plugin and
   * the Console's detected/undetected counts. Default true. Set false to record only
   * fired/errored events (leaner batches).
   */
  recordUndetectedEvents?: boolean;
  maxJsonSize?: number;
  maxDepth?: number;
}

interface Buffer {
  invocation: InvocationRecord;
  events: Map<string, EventRecord>; // keyed by event name
  eventIdByName: Map<string, string>;
  jobs: Map<string, JobRecord>; // keyed by job execution id
  timer?: ReturnType<typeof setInterval>;
}

const FAILED_STATUSES = new Set(['failed', 'timed_out', 'cancelled']);

export function observability(config: ObservabilityConfig): EventKitPlugin {
  if (typeof config?.sink !== 'function') {
    throw new Error('observability() requires a `sink` function to flush records (e.g. graphqlSink(...)).');
  }
  const captureSourcePayload = config.captureSourcePayload !== false;
  const persistJobsAtStart = config.persistJobsAtStart !== false;
  const captureJobMetadata = config.captureJobMetadata !== false;
  const captureErrorStacks = config.captureErrorStacks !== false;
  const recordUndetectedEvents = config.recordUndetectedEvents !== false;
  const serOpts = { maxDepth: config.maxDepth ?? 10, ...(config.maxJsonSize ? { maxJsonSize: config.maxJsonSize } : {}) };

  const buffers = new Map<string, Buffer>();
  const stack = (s?: string): string | undefined => (captureErrorStacks ? s : undefined);
  const reportSinkError =
    config.onSinkError ??
    ((err: unknown, ctx: { invocationId: string; final: boolean }) => {
      // eslint-disable-next-line no-console
      console.warn(
        `[eventkit] observability sink flush failed (invocation=${ctx.invocationId}, final=${ctx.final}); ` +
          `telemetry for this invocation may be incomplete (e.g. a job row left 'running').`,
        err,
      );
    });

  const eventRecord = (buf: Buffer, invocationId: string, correlationId: string, eventName: string): EventRecord => {
    let rec = buf.events.get(eventName);
    if (!rec) {
      const now = new Date().toISOString();
      rec = {
        id: newId(),
        invocation_id: invocationId,
        correlation_id: correlationId,
        event_name: eventName,
        detected: false,
        jobs_count: 0,
        jobs_succeeded: 0,
        jobs_failed: 0,
        status: 'pending',
        created_at: now,
        updated_at: now,
      };
      buf.events.set(eventName, rec);
      buf.eventIdByName.set(eventName, rec.id);
    }
    return rec;
  };

  const buildBatch = (buf: Buffer): ObservabilityBatch => ({
    invocation: buf.invocation,
    events: [...buf.events.values()],
    jobs: [...buf.jobs.values()],
  });

  const flush = async (invocationId: string, final: boolean): Promise<void> => {
    const buf = buffers.get(invocationId);
    if (!buf) return;
    // On a final flush the invocation has ended, so stop the periodic timer up front — no
    // more mid-flight snapshots are wanted even if this write fails. But do NOT discard the
    // buffer until the sink has DURABLY accepted the batch. Deleting it up front was the bug:
    // the sink writes invocation → events → jobs sequentially, and a failure after the
    // invocations mutation permanently and silently lost the job/event terminal states,
    // leaving a job stuck 'running' under a 'completed' invocation. Keeping the buffer lets a
    // later `onFlush` (process teardown) retry the terminal write.
    if (final && buf.timer) {
      clearInterval(buf.timer);
      delete buf.timer;
    }
    try {
      await config.sink(buildBatch(buf));
      if (final) buffers.delete(invocationId); // durably written → safe to drop
    } catch (err) {
      if (config.strict) throw err;
      // Best-effort: a telemetry write failure must not fail business execution — but it MUST
      // be visible (silent loss is undiagnosable), and the buffer MUST survive so onFlush can
      // retry the terminal write rather than dropping the job's terminal state forever.
      reportSinkError(err, { invocationId, final });
    }
  };

  return {
    name: 'observability',

    onInvocationStart(ctx: InvocationContext) {
      const now = new Date().toISOString();
      const meta = ctx.envelope.meta as Partial<SourceMeta>;
      const invocation: InvocationRecord = {
        id: ctx.invocationId,
        correlation_id: ctx.correlationId,
        source_system: ctx.source,
        source_type: ctx.sourceType,
        status: 'running',
        created_at: now,
        updated_at: now,
        source_event_time: ctx.envelope.receivedAt.toISOString(),
        events_detected_count: 0,
        total_jobs_run: 0,
        total_jobs_succeeded: 0,
        total_jobs_failed: 0,
      };
      // Prefer the source's business identity (Hasura trigger name) over the
      // platform runtime function name ('handler' under netlify dev); fall back to
      // either, then 'unknown' (source_function is NOT NULL).
      invocation.source_function = meta.sourceFunction ?? ctx.sourceFunction ?? 'unknown';
      if (meta.sourceTable) invocation.source_table = meta.sourceTable;
      if (meta.sourceOperation) invocation.source_operation = meta.sourceOperation;
      if (meta.sourceEventId) invocation.source_event_id = meta.sourceEventId;
      if (meta.sourceUserEmail) invocation.source_user_email = meta.sourceUserEmail;
      if (meta.sourceUserRole) invocation.source_user_role = meta.sourceUserRole;
      if (meta.sourceJobId) invocation.source_job_id = meta.sourceJobId;
      if (captureSourcePayload && ctx.envelope.payload !== undefined) {
        invocation.source_event_payload = safeSerialize(ctx.envelope.payload, serOpts);
      }
      if (ctx.request.meta !== undefined) invocation.context_data = safeSerialize(ctx.request.meta, serOpts);

      const buf: Buffer = { invocation, events: new Map(), eventIdByName: new Map(), jobs: new Map() };
      if (config.flushIntervalMs && config.flushIntervalMs > 0) {
        buf.timer = setInterval(() => void flush(ctx.invocationId, false), config.flushIntervalMs);
        if (typeof buf.timer.unref === 'function') buf.timer.unref();
      }
      buffers.set(ctx.invocationId, buf);
    },

    onEventDetectionEnd(ctx: DetectorContext, result) {
      // Record every evaluation by default (detected + not_detected) for Console
      // parity; with recordUndetectedEvents:false, record only fired/errored events.
      if (!recordUndetectedEvents && !result.detected && !result.error) return;
      const buf = buffers.get(ctx.invocationId);
      if (!buf) return;
      const rec = eventRecord(buf, ctx.invocationId, ctx.correlationId, result.eventName);
      rec.detected = result.detected;
      rec.detection_duration_ms = result.durationMs;
      rec.status = result.detected ? 'detected' : 'not_detected';
      if (result.error) {
        rec.detection_error = result.error.message;
        const s = stack(result.error.stack);
        if (s !== undefined) rec.detection_error_stack = s;
        rec.status = 'failed';
      }
      rec.updated_at = new Date().toISOString();
    },

    onEventHandlerEnd(ctx: HandlerContext, result) {
      const buf = buffers.get(ctx.invocationId);
      if (!buf) return;
      const rec = eventRecord(buf, ctx.invocationId, ctx.correlationId, result.eventName);
      rec.detected = true;
      rec.handler_duration_ms = result.durationMs;
      rec.jobs_count = result.jobs.length;
      rec.jobs_succeeded = result.jobs.filter(j => j.status === 'completed').length;
      rec.jobs_failed = result.jobs.filter(j => FAILED_STATUSES.has(j.status)).length;
      rec.status = result.error ? 'failed' : 'completed';
      if (result.error) {
        rec.handler_error = result.error.message;
        const s = stack(result.error.stack);
        if (s !== undefined) rec.handler_error_stack = s;
      }
      rec.updated_at = new Date().toISOString();
    },

    async onJobStart(ctx: JobContext) {
      const buf = buffers.get(ctx.invocationId);
      if (!buf) return;
      const now = new Date().toISOString();
      const existing = buf.jobs.get(ctx.job.id);
      const rec: JobRecord = existing ?? {
        id: ctx.job.id,
        invocation_id: ctx.invocationId,
        correlation_id: ctx.correlationId,
        job_name: ctx.job.name,
        status: 'running',
        created_at: now,
        updated_at: now,
      };
      rec.job_function_name = ctx.job.name;
      rec.status = 'running';
      rec.updated_at = now;
      const eventId = buf.eventIdByName.get(ctx.event.name);
      if (eventId) rec.event_execution_id = eventId;
      if (captureJobMetadata && ctx.job.metadata) rec.job_options = safeSerialize(ctx.job.metadata, serOpts);
      buf.jobs.set(ctx.job.id, rec);
      // Make this job's row (and its invocation) durable BEFORE the job body runs, so a
      // child invocation the job spawns via DB writes can resolve its source_job_id FK to
      // this row instead of being orphaned as a false origin. The runtime awaits onJobStart
      // before invoking the job fn, so this flush completes first. Idempotent (sink upserts).
      if (persistJobsAtStart) await flush(ctx.invocationId, false);
    },

    onJobEnd(ctx: JobContext, execution: JobExecution) {
      const buf = buffers.get(ctx.invocationId);
      if (!buf) return;
      const rec = buf.jobs.get(execution.id);
      if (!rec) return;
      rec.status = execution.status;
      if (execution.durationMs !== undefined) rec.duration_ms = execution.durationMs;
      if (execution.output !== undefined) rec.result = safeSerialize(execution.output, serOpts);
      if (execution.error) {
        rec.error_message = execution.error.message;
        const s = stack(execution.error.stack);
        if (s !== undefined) rec.error_stack = s;
      } else {
        // A retried attempt that finally succeeded must not keep a prior attempt's error.
        delete rec.error_message;
        delete rec.error_stack;
      }
      rec.updated_at = new Date().toISOString();
    },

    // Framework-level errors (normalize/plugin) and detector/handler crashes:
    // mark the invocation failed so the crash is visible even outside *End hooks.
    onError(ctx: ErrorContext) {
      // A 'warn' is an alarm for alerting backends (ADR-041 warnAtDepth), not a
      // record failure — do not touch the invocation record.
      if (ctx.severity === 'warn') return;
      const buf = buffers.get(ctx.invocationId);
      if (!buf) return;
      buf.invocation.error_message = ctx.error.message;
      const s = stack(ctx.error.stack);
      if (s !== undefined) buf.invocation.error_stack = s;
      if (buf.invocation.status === 'running') buf.invocation.status = 'failed';
      // A halted chain (ADR-041) must be QUERYABLE, not read as a benign zero-event
      // success: stamp a durable halted marker with the depth/ceiling the branded
      // LoopDetectedError carries on its serialized `data`.
      if (ctx.phase === 'chain-guard') {
        const data = ctx.error.data;
        const depth = data && typeof data['depth'] === 'number' ? data['depth'] : undefined;
        const ceiling = data && typeof data['ceiling'] === 'number' ? data['ceiling'] : undefined;
        if (depth !== undefined && ceiling !== undefined) {
          const existing =
            buf.invocation.context_data && typeof buf.invocation.context_data === 'object'
              ? (buf.invocation.context_data as Record<string, unknown>)
              : {};
          buf.invocation.context_data = { ...existing, halted: { depth, ceiling } };
        }
      }
      buf.invocation.updated_at = new Date().toISOString();
    },

    async onInvocationEnd(ctx: InvocationContext, result: InvocationResult) {
      const buf = buffers.get(ctx.invocationId);
      if (buf) {
        const jobs = [...buf.jobs.values()];
        const failed = jobs.filter(j => FAILED_STATUSES.has(j.status)).length;
        buf.invocation.total_duration_ms = result.durationMs;
        buf.invocation.events_detected_count = [...buf.events.values()].filter(e => e.detected).length;
        buf.invocation.total_jobs_run = jobs.length;
        buf.invocation.total_jobs_succeeded = jobs.filter(j => j.status === 'completed').length;
        buf.invocation.total_jobs_failed = failed;
        buf.invocation.status = result.timedOut
          ? 'timeout'
          : failed > 0 || buf.invocation.error_message
            ? 'failed'
            : 'completed';
        buf.invocation.updated_at = new Date().toISOString();
      }
      await flush(ctx.invocationId, true);
    },

    async onFlush() {
      for (const id of [...buffers.keys()]) await flush(id, true);
    },
  };
}
