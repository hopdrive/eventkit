// =============================================================================
// @hopdrive/eventkit/plugins/observability
// =============================================================================
// First-class observability (§13). A PURE lifecycle observer that buffers an
// Invocation → Event → Job record hierarchy per invocation and flushes it ONCE at
// onInvocationEnd (and onFlush) via an injected `sink`. It MUST NOT do a synchronous
// network write per job on the hot path. Generic: the transport (GraphQL, HTTP, …)
// is the consumer's `sink`, not baked in (ADR-024). Best-effort by default; a
// failed flush does not fail business execution unless `strict` is set.
import type {
  DetectorContext,
  EventKitPlugin,
  HandlerContext,
  InvocationContext,
  InvocationResult,
  JobContext,
  JobExecution,
  SerializedError,
} from '../../core/index.js';
import { serializeOutput } from '../../core/index.js';

export interface InvocationRecord {
  invocationId: string;
  correlationId: string;
  source: string;
  sourceType: string;
  sourceFunction?: string;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  ok?: boolean;
  timedOut?: boolean;
}

export interface EventRecord {
  invocationId: string;
  eventName: string;
  detected: boolean;
  detectorDurationMs?: number;
  handlerDurationMs?: number;
  error?: SerializedError;
}

export interface JobRecord {
  id: string;
  invocationId: string;
  correlationId: string;
  eventName: string;
  jobName: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  output?: unknown;
  error?: SerializedError;
}

export interface ObservabilityBatch {
  invocation: InvocationRecord;
  events: EventRecord[];
  jobs: JobRecord[];
}

export interface ObservabilityConfig {
  /** Flush the per-invocation batch. Wire a GraphQL/HTTP transport here. */
  sink: (batch: ObservabilityBatch) => void | Promise<void>;
  /** When true, a sink failure is rethrown (surfacing via onError); default best-effort. */
  strict?: boolean;
}

interface Buffer {
  invocation: InvocationRecord;
  events: Map<string, EventRecord>;
  jobs: JobRecord[];
}

export function observability(config: ObservabilityConfig): EventKitPlugin {
  if (typeof config?.sink !== 'function') {
    throw new Error("observability() requires a `sink` function to flush records (e.g. a GraphQL transport).");
  }
  const buffers = new Map<string, Buffer>();

  const buffer = (invocationId: string): Buffer | undefined => buffers.get(invocationId);

  const eventRecord = (buf: Buffer, eventName: string, invocationId: string): EventRecord => {
    let rec = buf.events.get(eventName);
    if (!rec) {
      rec = { invocationId, eventName, detected: false };
      buf.events.set(eventName, rec);
    }
    return rec;
  };

  const flush = async (invocationId: string): Promise<void> => {
    const buf = buffers.get(invocationId);
    if (!buf) return;
    buffers.delete(invocationId);
    const batch: ObservabilityBatch = {
      invocation: buf.invocation,
      events: [...buf.events.values()],
      jobs: buf.jobs,
    };
    try {
      await config.sink(batch);
    } catch (err) {
      if (config.strict) throw err;
      // best-effort: a telemetry write failure must not fail business execution
    }
  };

  return {
    name: 'observability',

    onInvocationStart(ctx: InvocationContext) {
      const invocation: InvocationRecord = {
        invocationId: ctx.invocationId,
        correlationId: ctx.correlationId,
        source: ctx.source,
        sourceType: ctx.sourceType,
        startedAt: ctx.startedAt,
      };
      if (ctx.sourceFunction !== undefined) invocation.sourceFunction = ctx.sourceFunction;
      buffers.set(ctx.invocationId, { invocation, events: new Map(), jobs: [] });
    },

    onEventDetectionEnd(ctx: DetectorContext, result) {
      if (!result.detected && !result.error) return; // only record events that fired or crashed
      const buf = buffer(ctx.invocationId);
      if (!buf) return;
      const rec = eventRecord(buf, result.eventName, ctx.invocationId);
      rec.detected = result.detected;
      rec.detectorDurationMs = result.durationMs;
      if (result.error) rec.error = result.error;
    },

    onEventHandlerEnd(ctx: HandlerContext, result) {
      const buf = buffer(ctx.invocationId);
      if (!buf) return;
      const rec = eventRecord(buf, result.eventName, ctx.invocationId);
      rec.detected = true;
      rec.handlerDurationMs = result.durationMs;
      if (result.error) rec.error = result.error;
    },

    onJobEnd(ctx: JobContext, execution: JobExecution) {
      const buf = buffer(ctx.invocationId);
      if (!buf) return;
      const rec: JobRecord = {
        id: execution.id,
        invocationId: execution.invocationId,
        correlationId: execution.correlationId,
        eventName: execution.eventName,
        jobName: execution.jobName,
        status: execution.status,
        attempt: execution.attempt,
        maxAttempts: execution.maxAttempts,
        startedAt: execution.startedAt,
      };
      if (execution.completedAt !== undefined) rec.completedAt = execution.completedAt;
      if (execution.durationMs !== undefined) rec.durationMs = execution.durationMs;
      if (execution.output !== undefined) rec.output = serializeOutput(execution.output);
      if (execution.error !== undefined) rec.error = execution.error;
      buf.jobs.push(rec);
    },

    async onInvocationEnd(ctx: InvocationContext, result: InvocationResult) {
      const buf = buffer(ctx.invocationId);
      if (buf) {
        buf.invocation.completedAt = new Date();
        buf.invocation.durationMs = result.durationMs;
        buf.invocation.ok = result.ok;
        if (result.timedOut !== undefined) buf.invocation.timedOut = result.timedOut;
      }
      await flush(ctx.invocationId);
    },

    async onFlush() {
      for (const id of [...buffers.keys()]) await flush(id);
    },
  };
}
