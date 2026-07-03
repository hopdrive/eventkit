// `runJobs(rt, event, jobs, options, jobInputCtx)` — the runtime-internal job
// executor (ADR-025). There is no consumer-facing `run()`: the runtime executes a
// module's declared `jobs` array directly during dispatch, so this receives the
// invocation runtime explicitly (no AsyncLocalStorage reach-around). Jobs always run
// in parallel with isolated failures (ADR-014; runOne never rejects), matching the
// legacy Promise.allSettled fan-out so a flaky job never blocks billing. Series
// execution / continueOnFailure are deferred (ADR-031). The branded `JobDefinition` +
// the throw below remain the backstop against a non-job entry.
import {
  job,
  serializeError,
  type DetectedEvent,
  type JobContext,
  type JobDefinition,
  type JobFunction,
  type JobExecution,
  type JobExecutionStatus,
  type JobInputContext,
  type RunOptions,
} from '../core/index.js';
import type { InvocationContext } from '../core/index.js';
import type { PluginManager } from './plugin-manager.js';
import { createHandlerLogger, createJobLogger } from './loggers.js';
import { newUuid } from './ids.js';

/**
 * Invocation-scoped runtime threaded explicitly to the executor: the plugin
 * manager, the per-invocation context, and the budget AbortSignal. (Formerly
 * carried via AsyncLocalStorage so a free `run()` could reach it; ADR-025 runs jobs
 * from the runtime, so it is passed directly.)
 */
export interface InvocationRuntime {
  pluginManager: PluginManager;
  invocation: InvocationContext;
  signal: AbortSignal;
}

// Concise lifecycle logging (transport-agnostic): emitted through pm.onLog so every
// log sink (grafana, console, …) gets the legacy-style narrative — `running N jobs`,
// one `✓/✗ jobName Nms` line per job, then `completed N jobs (M failed)`. Structured
// detail (status, jobExecutionId) rides in `data`; the observability DB still owns the
// authoritative rows. Skipped entirely for an empty job list.
const plural = (n: number) => (n === 1 ? 'job' : 'jobs');

function emitRunStart(rt: InvocationRuntime, event: DetectedEvent, count: number): void {
  const { invocation } = rt;
  createHandlerLogger(
    { invocationId: invocation.invocationId, correlationId: invocation.correlationId, eventName: event.name, scope: 'handler' },
    entry => void rt.pluginManager.onLog(entry),
  ).info(`${event.name} running ${count} ${plural(count)}`);
}

function emitRunEnd(rt: InvocationRuntime, event: DetectedEvent, executions: JobExecution<any>[]): void {
  const { invocation } = rt;
  const sink = (entry: Parameters<typeof rt.pluginManager.onLog>[0]) => void rt.pluginManager.onLog(entry);
  const correlation = { invocationId: invocation.invocationId, correlationId: invocation.correlationId, eventName: event.name };
  for (const x of executions) {
    const icon = x.status === 'completed' ? '✓' : x.status === 'skipped' ? '⊘' : '✗';
    const suffix = x.error ? ` (${x.error.name})` : '';
    createHandlerLogger({ ...correlation, jobName: x.jobName, scope: 'job' }, sink)
      .info(`${icon} ${x.jobName} ${x.durationMs}ms${suffix}`, { jobExecutionId: x.id, status: x.status });
  }
  const failed = executions.filter(x => x.status === 'failed' || x.status === 'timed_out').length;
  createHandlerLogger({ ...correlation, scope: 'handler' }, sink)
    .info(`${event.name} completed ${executions.length} ${plural(executions.length)}${failed ? ` (${failed} failed)` : ''}`);
}

const isJobDefinition = (x: unknown): x is JobDefinition =>
  !!x && typeof x === 'object' && (x as { __eventkitJob?: unknown }).__eventkitJob === true;

/**
 * Run a module's declared `jobs`. `jobInputCtx` is the detected event's handler
 * context plus the module's `prepare` output (`prepared`); it is the context a
 * per-job `input` mapper is resolved against, and `prepared` is merged into every
 * job's `ctx.input`. The runtime calls this once per detected event.
 */
export async function runJobs<TResult = unknown>(
  rt: InvocationRuntime,
  event: DetectedEvent,
  rawJobs: (JobDefinition<any> | JobFunction<any>)[],
  options: RunOptions | undefined,
  jobInputCtx: JobInputContext,
): Promise<JobExecution<TResult>[]> {
  // Normalize: a branded job(...) passes through; a bare job function is auto-wrapped
  // (ADR-025 amendment). registerEvent already normalized these, so this is the backstop
  // — it also throws on any truly non-job entry (a look-alike object, `false`, `null`),
  // keeping conditional inclusion impossible.
  const jobs: JobDefinition<any>[] = rawJobs.map((entry, i) => {
    if (isJobDefinition(entry)) return entry as JobDefinition<any>;
    if (typeof entry === 'function') return job(entry as JobFunction<any>);
    throw new Error(
      `Event '${event.name}' has a non-job entry in its jobs array at index ${i} (got ${describe(entry)}). ` +
        `Each entry must be a job(fn) or a bare job function (ADR-025); put conditions in the detector or inside a job.`,
    );
  });

  const prepared = (jobInputCtx.prepared as Record<string, unknown> | undefined) ?? {};

  if (jobs.length > 0) emitRunStart(rt, event, jobs.length);

  // Jobs always run in parallel with isolated failures — runOne never rejects (ADR-014).
  // Series execution / continueOnFailure are deferred (ADR-031).
  const executions: JobExecution<TResult>[] = await Promise.all(
    jobs.map(def => runOne<TResult>(event, def, rt, options, prepared, jobInputCtx)),
  );

  if (jobs.length > 0) emitRunEnd(rt, event, executions);
  return executions;
}

const describe = (x: unknown): string =>
  x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x === 'function' ? 'function' : typeof x;

/** Resolve a job's `input`: a static object, or a pure mapper called with the input context. */
function resolveInput(def: JobDefinition, jobInputCtx: JobInputContext): Record<string, unknown> {
  const raw = def.options.input;
  const resolved = typeof raw === 'function' ? (raw as (ctx: JobInputContext) => unknown)(jobInputCtx) : raw;
  return (resolved as Record<string, unknown> | undefined) ?? {};
}

class JobTimeoutError extends Error {
  override readonly name = 'JobTimeoutError';
}

/**
 * Thrown by `ctx.skip(reason)` (ADR-035) and caught by the executor below. It is a
 * control-flow signal, not a failure: the job ends `'completed'` with the reason
 * recorded as `metadata.conditionNotMet`. Defined and caught in this same module, so
 * `instanceof` is reliable (no cross-bundle copy concern).
 */
class SkipSignal extends Error {
  override readonly name = 'SkipSignal';
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function runOne<TResult>(
  event: DetectedEvent,
  def: JobDefinition,
  rt: InvocationRuntime,
  runOptions: RunOptions | undefined,
  prepared: Record<string, unknown>,
  jobInputCtx: JobInputContext,
): Promise<JobExecution<TResult>> {
  const { pluginManager, invocation, signal } = rt;
  const jobId = newUuid();
  const jobName = def.name;
  const maxAttempts = (def.options.retries ?? 0) + 1;
  const metadata = def.options.metadata ?? {};
  const timeoutMs = def.options.timeoutMs ?? runOptions?.timeoutMs;
  // Resolve the per-job input once (a mapper sees the event + prepared, never itself).
  const perJobInput = resolveInput(def, jobInputCtx);

  const base: JobExecution<TResult> = {
    id: jobId,
    jobName,
    eventId: event.id,
    eventName: event.name,
    invocationId: invocation.invocationId,
    correlationId: invocation.correlationId,
    status: 'queued',
    attempt: 0,
    maxAttempts,
    startedAt: new Date(),
    metadata,
  };

  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    const startedAt = new Date();
    const start = Date.now();

    // Build the job context, then merge the input channels (ADR-025 precedence,
    // lowest→highest): plugin baselines (ADR-020, e.g. Batch row input) →
    // `prepare` output → the job's own resolved input. The job reads it from
    // `ctx.input` and stays plugin-agnostic.
    const ctx = buildJobContext(event, def, rt, jobId, attempt, signal);
    const { input: baselines, trackingToken } = pluginManager.collectJobContribution(ctx);
    ctx.input = { ...baselines, ...prepared, ...perJobInput };
    const defaultToken = `${event.source}.${invocation.correlationId}.${jobId}`;
    ctx.trackingToken = trackingToken ?? defaultToken;

    if (signal.aborted) {
      // Framework-level (invocation) log so the drop is visible in the log stream
      // (onLog → Grafana), not only via onError — §11.3 onLog breadth.
      invocation.log.warn(`Job '${jobName}' cancelled before start (invocation budget expired)`, { jobName, status: 'cancelled' });
      return finish(base, 'cancelled', { attempt, startedAt, start });
    }

    await pluginManager.onJobStart(ctx);

    try {
      const output = await race(def.fn(ctx) as Promise<TResult> | TResult, signal, timeoutMs);
      const exec = finish(base, 'completed', { attempt, startedAt, start, output });
      await pluginManager.onJobEnd(ctx, exec);
      return exec;
    } catch (err) {
      // ctx.skip(reason) (ADR-035): a branch-not-taken, not a failure. The job ran and
      // chose to do nothing → terminal status stays 'completed', with the reason recorded
      // as structured metadata. No retry, no reportError.
      if (err instanceof SkipSignal) {
        const exec = finish(base, 'completed', { attempt, startedAt, start });
        exec.metadata = { ...exec.metadata, conditionNotMet: { reason: err.reason } };
        await pluginManager.onJobEnd(ctx, exec);
        return exec;
      }
      const status: JobExecutionStatus =
        err instanceof JobTimeoutError ? 'timed_out' : signal.aborted ? 'cancelled' : 'failed';
      // A timeout / budget cancellation is an invocation-level event, not just a job
      // failure: surface it on the framework log stream (onLog → Grafana) so it's visible
      // even when no onError-consuming plugin is registered (§11.3 onLog breadth).
      if (status === 'timed_out' || status === 'cancelled') {
        invocation.log.warn(`Job '${jobName}' ${status}`, { jobName, attempt, status });
      }
      const isLastAttempt = attempt >= maxAttempts;
      const retryable = status === 'failed' && !isLastAttempt;

      const exec = finish(base, status, { attempt, startedAt, start, error: serializeError(err) });
      await pluginManager.onJobEnd(ctx, exec);
      await pluginManager.reportError(err, 'job', {
        invocationId: invocation.invocationId,
        correlationId: invocation.correlationId,
        eventName: event.name,
        jobName,
      });

      if (!retryable) return exec;
      // else: loop and retry immediately (durable delayed retry is Batch's job)
    }
  }
  // Unreachable, but satisfies the type checker.
  return finish(base, 'failed', { attempt, startedAt: base.startedAt, start: Date.now() });
}

function buildJobContext(
  event: DetectedEvent,
  def: JobDefinition,
  rt: InvocationRuntime,
  jobId: string,
  attempt: number,
  signal: AbortSignal,
  // The internal working context: `input` is dynamic (plugin baselines + prepared +
  // per-job input merged at runtime), so it is `any` here and set by the caller.
  // Plugins receive it as the bare public `JobContext` (they read metadata/envelope,
  // never `input`); the job fn receives its own `JobContext<TInput>`.
): JobContext<any> {
  const { pluginManager, invocation } = rt;
  const metadata = def.options.metadata ?? {};
  const log = createJobLogger(
    {
      invocationId: invocation.invocationId,
      correlationId: invocation.correlationId,
      eventName: event.name,
      jobName: def.name,
      scope: def.name,
    },
    entry => void pluginManager.onJobLog(ctx, entry),
  );

  const ctx: JobContext<any> = {
    invocationId: invocation.invocationId,
    correlationId: invocation.correlationId,
    event,
    envelope: event.envelope,
    input: {},
    trackingToken: '',
    job: { id: jobId, name: def.name, attempt, options: def.options, metadata },
    log,
    progress: (value, md) => pluginManager.onJobProgress(ctx, md ? { value, at: new Date(), metadata: md } : { value, at: new Date() }),
    checkpoint: (name, md) => pluginManager.onJobCheckpoint(ctx, md ? { name, at: new Date(), metadata: md } : { name, at: new Date() }),
    skip: (reason: string) => { throw new SkipSignal(reason); },
    signal,
  };
  return ctx;
}

function finish<TResult>(
  base: JobExecution<TResult>,
  status: JobExecutionStatus,
  parts: { attempt: number; startedAt: Date; start: number; output?: TResult; error?: JobExecution['error'] },
): JobExecution<TResult> {
  const completedAt = new Date();
  const exec: JobExecution<TResult> = {
    ...base,
    status,
    attempt: parts.attempt,
    startedAt: parts.startedAt,
    completedAt,
    durationMs: Date.now() - parts.start,
  };
  if (parts.output !== undefined) exec.output = parts.output;
  if (parts.error !== undefined) exec.error = parts.error;
  return exec;
}

/** Race a job against the invocation AbortSignal and an optional per-job timeout. */
async function race<T>(work: Promise<T> | T, signal: AbortSignal, timeoutMs?: number): Promise<T> {
  if (!(work instanceof Promise) && timeoutMs === undefined && !signal.aborted) return work;

  const contenders: Promise<T>[] = [Promise.resolve(work)];

  if (timeoutMs !== undefined && timeoutMs > 0) {
    contenders.push(
      new Promise<T>((_, reject) => {
        const t = setTimeout(() => reject(new JobTimeoutError(`Job exceeded ${timeoutMs}ms`)), timeoutMs);
        if (typeof t.unref === 'function') t.unref();
      }),
    );
  }

  contenders.push(
    new Promise<T>((_, reject) => {
      if (signal.aborted) reject(new Error('Invocation aborted'));
      else signal.addEventListener('abort', () => reject(new Error('Invocation aborted')), { once: true });
    }),
  );

  return Promise.race(contenders);
}
