// `run(event, jobs, options?)` — the job executor a handler calls. Defaults are
// PINNED (ADR-014): mode='parallel', continueOnFailure=true, matching the legacy
// Promise.allSettled fan-out so a flaky job never blocks billing. `jobs` is a
// strict JobDefinition[]: any non-job entry throws (ADR-018). Invocation-scoped
// state (plugins, signal, source) is read from the AsyncLocalStorage store, so
// the public signature carries none of it.
import {
  serializeError,
  type DetectedEvent,
  type JobContext,
  type JobDefinition,
  type JobExecution,
  type JobExecutionStatus,
  type RunOptions,
} from '../core/index.js';
import { currentRuntime, type InvocationRuntime } from './invocation-store.js';
import { createJobLogger } from './loggers.js';
import { newUuid } from './ids.js';

const isJobDefinition = (x: unknown): x is JobDefinition =>
  !!x && typeof x === 'object' && (x as { __eventkitJob?: unknown }).__eventkitJob === true;

// `jobs` is `JobDefinition<any>[]`, not `JobDefinition[]`: each job carries its own
// TInput, so a heterogeneous list needs the bidirectional `any` to be accepted —
// `JobDefinition<undefined>[]` would reject every typed job, and `<unknown>` fails
// on parameter contravariance. The ADR-018 brand (`__eventkitJob: true`) still makes
// a non-job entry (e.g. `false` from `cond && job()`) a compile error regardless.
export async function run<TResult = unknown>(
  event: DetectedEvent,
  jobs: JobDefinition<any>[],
  options?: RunOptions,
): Promise<JobExecution<TResult>[]> {
  // ADR-018: strict JobDefinition[]. Throw loudly on any non-job entry (e.g. a
  // `false` left by `cond && job(...)`, a bare function, or a look-alike object).
  jobs.forEach((entry, i) => {
    if (!isJobDefinition(entry)) {
      throw new Error(
        `run() received a non-job entry at index ${i} (got ${describe(entry)}). ` +
          `Handlers are declarative job lists: every entry must be job(...). ` +
          `Put conditions in the detector (a named event) or inside the job (ADR-018).`,
      );
    }
  });

  const rt = currentRuntime();
  if (!rt) {
    throw new Error('run() was called outside of an invocation. Call it from within a handler dispatched by kit.handle().');
  }

  const mode = options?.mode ?? 'parallel';
  const continueOnFailure = options?.continueOnFailure ?? true;

  if (mode === 'series') {
    const executions: JobExecution<TResult>[] = [];
    let stopped = false;
    for (const def of jobs) {
      if (stopped) {
        executions.push(skipped<TResult>(event, def, rt));
        continue;
      }
      const exec = await runOne<TResult>(event, def, rt, options);
      executions.push(exec);
      const failed = exec.status === 'failed' || exec.status === 'timed_out';
      const jobContinue = def.options.continueOnFailure ?? continueOnFailure;
      if (failed && !jobContinue) stopped = true;
    }
    return executions;
  }

  // parallel (default): launch all; isolated failures (runOne never rejects).
  return Promise.all(jobs.map(def => runOne<TResult>(event, def, rt, options)));
}

const describe = (x: unknown): string =>
  x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x === 'function' ? 'function' : typeof x;

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
): Promise<JobExecution<TResult>> {
  const { pluginManager, invocation, signal } = rt;
  const jobId = newUuid();
  const jobName = def.name;
  const maxAttempts = (def.options.retries ?? 0) + 1;
  const metadata = def.options.metadata ?? {};
  const timeoutMs = def.options.timeoutMs ?? runOptions?.timeoutMs;

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

    // Build the job context. First with the handler's own input, so plugins can
    // self-correlate off the context; then merge plugin baselines UNDER the
    // handler input (ADR-020: handler keys win).
    const ctx = buildJobContext(event, def, rt, jobId, attempt, signal);
    const { input: baselines, trackingToken } = pluginManager.collectJobContribution(ctx);
    ctx.input = { ...baselines, ...((def.options.input as Record<string, unknown> | undefined) ?? {}) };
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
  // The internal working context: `input` is dynamic (plugin baselines + handler
  // input merged at runtime), so it is `any` here. Plugins receive it as the bare
  // public `JobContext` (they read metadata/envelope, never `input`); the job fn
  // receives its own `JobContext<TInput>`.
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
    input: (def.options.input as Record<string, unknown> | undefined) ?? {},
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
