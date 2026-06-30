// =============================================================================
// Jobs: data channel, definition, context, execution (§9.4–§9.6, §10)
// =============================================================================

import type { EventName, JobName, InvocationId, CorrelationId } from './brands.js';
import type { EventEnvelope, DetectedEvent } from './envelope.js';
import type { HandlerContext } from './context.js';
import type { JobLogger } from './logger.js';
import type { SerializedError } from './errors.js';
import { asJobName } from './brands.js';

/**
 * The context a per-job `input` MAPPER receives (ADR-025). It is the detected
 * event's handler context (event, envelope, source-enriched fields) plus the
 * `prepared` object returned by the module's `prepare`. It deliberately does NOT
 * include the job's own resolved `input` — a mapper derives input from the event
 * and shared prepared data, never from itself (no self-reference). The runtime
 * resolves a mapper once, at job-build time, before the job runs.
 */
export type JobInputContext<
  TPayload = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TPrepared = Record<string, unknown>,
> = HandlerContext<TPayload, TMeta> & { prepared: TPrepared };

/**
 * The two-channel job options bag (ADR-011). The single most important contract
 * for the migration: `input` is live and request-scoped and is NEVER persisted
 * or serialized; `metadata` is serializable and IS persisted by Batch /
 * recorded by Observability. There is deliberately NO `durable` field —
 * durability is emergent from registering the Batch plugin (ADR-015), so
 * core JobOptions never names batch.
 */
export interface JobOptions<TInput = undefined> {
  /** Overrides the job name (else derived from the function name). */
  name?: string;
  /** Per-job timeout; the runtime races the job against it and marks `timed_out`. */
  timeoutMs?: number;
  /** Retry attempts core will make (durable scheduling of retries is Batch'). */
  retries?: number;
  tags?: string[];
  /** Per-job override of the run-level continue-on-failure default. */
  continueOnFailure?: boolean;
  /**
   * Request-scoped data handed to the job. NEVER persisted, logged, or serialized.
   * Live clients (`sdk`), closures, and source rows belong here. Either a static
   * object, or a pure mapper `(ctx: JobInputContext) => TInput` the runtime resolves
   * once before the job runs — derive input from the event/prepared, not from
   * siblings (ADR-025: jobs are mutually ignorant). The resolved value merges
   * HIGHEST over plugin baselines and `prepare` output.
   */
  input?: TInput | ((ctx: JobInputContext) => TInput);
  /**
   * Serializable annotations. Persisted by Batch, recorded by Observability.
   * MUST be JSON-serializable.
   */
  metadata?: Record<string, unknown>;
}

export type JobFunction<TInput = undefined, TResult = unknown> = (
  ctx: JobContext<TInput>,
) => Promise<TResult> | TResult;

/**
 * The product of `job(fn, options)`. Branded (`__eventkitJob`) so that a
 * conditional entry — `cond && job(fn)`, which has type `false | JobDefinition`
 * — is NOT assignable to `JobDefinition[]` and fails to compile (ADR-018, §3.9).
 * Conditional behavior belongs in the detector (a named event) or inside the
 * job (input-driven), never as a hidden handler branch.
 */
export interface JobDefinition<TInput = undefined, TResult = unknown> {
  readonly __eventkitJob: true;
  fn: JobFunction<TInput, TResult>;
  name: JobName;
  options: JobOptions<TInput>;
}

/** A progress sample reported by a job; fraction in `[0,1]` (D15). */
export interface JobProgress {
  value: number;
  at: Date;
  metadata?: Record<string, unknown>;
}

/** A named milestone a durable job records so a retry can skip completed work. */
export interface JobCheckpoint {
  name: string;
  at: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Context handed to a running job. `input` is the resolved request-scoped data
 * (`{ ...pluginInputBaselines, ...options.input }`, handler keys win — ADR-020).
 * `trackingToken` is an ambient outbound provenance token (§13). The nested
 * `job.metadata` is the serializable channel — never the live `input`.
 */
export interface JobContext<
  TInput = undefined,
  TPayload = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  invocationId: InvocationId;
  correlationId: CorrelationId;
  event: DetectedEvent<TPayload, TMeta>;
  envelope: EventEnvelope<TPayload, TMeta>;
  input: TInput;
  /** Deterministic outbound provenance token jobs stamp into `updated_by` (§13). */
  trackingToken: string;
  job: {
    id: string;
    name: JobName;
    attempt: number;
    options: JobOptions<TInput>;
    metadata: Record<string, unknown>;
  };
  log: JobLogger;
  progress(value: number, metadata?: Record<string, unknown>): Promise<void>;
  checkpoint(name: string, metadata?: Record<string, unknown>): Promise<void>;
  signal?: AbortSignal;
}

/**
 * What a plugin's `augmentJobContext` may contribute before a job runs (ADR-020).
 * Two live, request-scoped channels — neither is ever persisted or serialized:
 *  - `input`   merges UNDER the handler's `options.input` (handler keys win), so
 *              the job reads it from `ctx.input` and stays plugin-agnostic.
 *  - `ambient` sets known ambient `JobContext` fields. Today the only ambient
 *              field is `trackingToken` (§13). This is deliberately NOT an open
 *              record: every contributable key has a defined landing on
 *              `JobContext`, so adding one is a deliberate change to BOTH this
 *              type and `JobContext` — never a silent untyped merge into a void.
 */
export interface JobContextContribution {
  input?: Record<string, unknown>;
  ambient?: { trackingToken?: string };
}

export type JobExecutionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'timed_out'
  | 'cancelled';

/** The result record of one job attempt (§9.6). */
export interface JobExecution<TResult = unknown> {
  id: string;
  jobName: JobName;
  eventId: string;
  eventName: EventName;
  invocationId: InvocationId;
  correlationId: CorrelationId;
  status: JobExecutionStatus;
  attempt: number;
  maxAttempts: number;
  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;
  output?: TResult;
  error?: SerializedError;
  metadata: Record<string, unknown>;
}

/**
 * What a module's `respond` seam receives alongside the context (ADR-026 amendment):
 * the event's settled job executions plus a convenience `ok` flag. Unlike `resolve`
 * (which runs concurrently and is sibling-ignorant), `respond` runs AFTER the jobs
 * settle, so it can compose the synchronous response from their results.
 */
export interface JobsResult<TResult = unknown> {
  /** Every job execution for this event, in declared order, already settled. */
  jobs: JobExecution<TResult>[];
  /** True when every job ended `completed` or `skipped` (same predicate as `InvocationResult.ok`). */
  ok: boolean;
}

/** Options for `run()`. Defaults are PINNED (ADR-014) — see `run`. */
export interface RunOptions {
  /** Default `'parallel'`. */
  mode?: 'parallel' | 'series';
  /** Default `true`. */
  continueOnFailure?: boolean;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Build a job definition. Pure constructor (no runtime execution) — the branded
 * `__eventkitJob` is what makes `jobs` a statically-knowable set (ADR-025).
 */
export function job<TInput = undefined, TResult = unknown>(
  fn: JobFunction<TInput, TResult>,
  options?: JobOptions<TInput>,
): JobDefinition<TInput, TResult> {
  const resolved = options ?? {};
  const name = asJobName(resolved.name || fn.name || 'anonymous');
  return { __eventkitJob: true, fn, name, options: resolved };
}

// The job EXECUTOR is runtime-internal (`../runtime/run.ts`) — it needs
// invocation-scoped state (plugins, signal, loggers). Per ADR-025 it is no longer a
// consumer-facing `run()`: the runtime runs a module's declared `jobs` directly
// during dispatch. `RunOptions` move onto the module as `run: {…}`.

/** Marker for not-yet-implemented stubs whose runtime behavior is deferred to a later phase. */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
  constructor(message: string) {
    super(message);
  }
}
