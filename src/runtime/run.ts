// `runJobs(rt, event, jobs, options, jobInputCtx)` — the runtime-internal job
// executor (ADR-025). There is no consumer-facing `run()`: the runtime executes a
// module's declared `jobs` array directly during dispatch, so this receives the
// invocation runtime explicitly (no AsyncLocalStorage reach-around). Defaults are
// PINNED (ADR-014): mode='parallel', continueOnFailure=true, matching the legacy
// Promise.allSettled fan-out so a flaky job never blocks billing. The branded
// `JobDefinition` + the throw below remain the backstop against a non-job entry.
import {
  serializeError,
  type DetectedEvent,
  type JobContext,
  type JobDefinition,
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
  jobs: JobDefinition<any>[],
  options: RunOptions | undefined,
  jobInputCtx: JobInputContext,
): Promise<JobExecution<TResult>[]> {
  // Backstop (the literal `jobs` array already makes conditional inclusion
  // inexpressible): throw loudly on any non-job entry that slipped past the brand.
  jobs.forEach((entry, i) => {
    if (!isJobDefinition(entry)) {
      throw new Error(
        `Event '${event.name}' has a non-job entry in its jobs array at index ${i} (got ${describe(entry)}). ` +
          `jobs must be a static array of job(...) entries (ADR-025); put conditions in the detector or inside a job.`,
      );
    }
  });

  const mode = options?.mode ?? 'parallel';
  const continueOnFailure = options?.continueOnFailure ?? true;
  const prepared = (jobInputCtx.prepared as Record<string, unknown> | undefined) ?? {};

  if (jobs.length > 0) emitRunStart(rt, event, jobs.length);

  let executions: JobExecution<TResult>[];
  if (mode === 'series') {
    executions = [];
    let stopped = false;
    for (const def of jobs) {
      if (stopped) {
        executions.push(skipped<TResult>(event, def, rt));
        continue;
      }
      const exec = await runOne<TResult>(event, def, rt, options, prepared, jobInputCtx);
      executions.push(exec);
      const failed = exec.status === 'failed' || exec.status === 'timed_out';
      const jobContinue = def.options.continueOnFailure ?? continueOnFailure;
      if (failed && !jobContinue) stopped = true;
    }
  } else {
    // parallel (default): launch all; isolated failures (runOne never rejects).
    executions = await Promise.all(jobs.map(def => runOne<TResult>(event, def, rt, options, prepared, jobInputCtx)));
  }

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

function skipped<TResult>(event: DetectedEvent, def: JobDefinition, rt: InvocationRuntime): JobExecution<TResult> {
  const now = new Date();
  return {
    id: newUuid(),
    jobName: def.name,
    eventId: event.id,
    eventName: event.name,
    invocationId: rt.invocation.invocationId,
    correlationId: rt.invocation.correlationId,
    status: 'skipped',
    attempt: 0,
    maxAttempts: (def.options.retries ?? 0) + 1,
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    metadata: def.options.metadata ?? {},
  };
}

class JobTimeoutError extends Error {
  override readonly name = 'JobTimeoutError';
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
    // lowest→highest): plugin baselines (ADR-020, e.g. BatchJobs row input) →
    // `prepare` output → the job's own resolved input. The job reads it from
    // `ctx.input` and stays plugin-agnostic.
    const ctx = buildJobContext(event, def, rt, jobId, attempt, signal);
    const { input: baselines, trackingToken } = pluginManager.collectJobContribution(ctx);
    ctx.input = { ...baselines, ...prepared, ...perJobInput };
    const defaultToken = `${event.source}.${invocation.correlationId}.${jobId}`;
    ctx.trackingToken = trackingToken ?? defaultToken;

    if (signal.aborted) {
      return finish(base, 'cancelled', { attempt, startedAt, start });
    }

    await pluginManager.onJobStart(ctx);

    try {
      const output = await race(def.fn(ctx) as Promise<TResult> | TResult, signal, timeoutMs);
      const exec = finish(base, 'completed', { attempt, startedAt, start, output });
      await pluginManager.onJobEnd(ctx, exec);
      return exec;
    } catch (err) {
      const status: JobExecutionStatus =
        err instanceof JobTimeoutError ? 'timed_out' : signal.aborted ? 'cancelled' : 'failed';
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
      // else: loop and retry immediately (durable delayed retry is BatchJobs' job)
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
