# EventKit RFC — Proposed Amendment: run() defaults (D) and the BatchJobs durable contract (E)

**Date:** 2026-06-28
**Status:** Proposed amendment to `EventKit Architecture RFC.md`; companion to `EventKit-RFC-amendment-A-B-C-202606281730.md`
**Scope:**
- **Amendment D** — pins `run()`'s execution-mode and failure defaults normatively (resolves evaluation LOST-3, the third silent killer).
- **Amendment E** — defines `DurableJobOptions`, the `batchJobs.*` factory surface, and the persisted lifecycle (resolves LOST-7). Builds directly on Amendment A's `input` (live) vs `metadata` (serialized) split.

Grounded in the real system: the `batch_jobs` table schema and `BatchJobStatus` enum from `@hopdrive/batchjobs`, the `batchJob({ run, onTimeout })` wrapper in `functions/db-*/jobs/runARBatchV2.js`, `batchJobUtils.updateBatchJobStatus` / `replaceCircularReferences`, and the producer/consumer split (`runARV2` enqueues; `runARBatchV2` consumes).

---

## Amendment D — Pin `run()` execution defaults

### Problem this fixes
RFC §9/§10 leaves `RunOptions.mode` and `continueOnFailure` defaults undefined, saying only that the default "should be chosen to preserve current behavior." That is a non-decision in a normative spec, and §10's prose actually *describes* series + stop-on-failure semantics — the **opposite** of the current runtime. The current `run()` (`hasura-event-detector/src/handler.ts:59`) is unambiguous:

```ts
const responses = await Promise.allSettled(safeJobs);   // all jobs run concurrently; one failure never blocks another
```

i.e. **parallel + fully failure-isolated**. The `outcome.resolved` "degraded mode" test already asserts the fan-out continues when one fetch fails. Money-path jobs (`runAR`, `runARV2`) share an invocation with flaky jobs (`publishGenericWebhook`); under a series/stop-on-failure default a flaky webhook would block billing.

### Decision (normative — replaces the relevant sentences in RFC §9 `RunOptions` and §10)
- `RunOptions.mode` **MUST** default to `'parallel'`.
- `RunOptions.continueOnFailure` **MUST** default to `true`.
- A job failure in the default configuration **MUST NOT** prevent other jobs in the same `run()` from executing or completing. `run()` **MUST** return a complete `JobExecution[]` containing both successful and failed records (mirroring today's `Promise.allSettled` + `preparedResponse`).
- These defaults are chosen explicitly for **migration parity**, not as a general recommendation. Applications **MAY** opt into `mode: 'series'` and/or `continueOnFailure: false` per-`run()` when ordering or short-circuiting is genuinely required, but the framework default preserves the isolated fan-out the existing 245 modules rely on.

```ts
export interface RunOptions {
  mode?: 'parallel' | 'series';        // default: 'parallel'
  continueOnFailure?: boolean;         // default: true
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}
```

### Note on `series` semantics (kept, but non-default)
RFC §10's description of series mode (stop subsequent jobs when `continueOnFailure:false`) is correct **as the description of an opt-in mode** and should stay. The only change is that it is no longer the default and is no longer described as "preserving current behavior" — it does the opposite, and the RFC must say so to prevent a reviewer from assuming series is the safe choice.

---

## Amendment E — `DurableJobOptions` and the BatchJobs durability contract

### Problem this fixes
RFC §9 types `durable?: boolean | DurableJobOptions` and §12 shows `durable: batchJobs.record(ctx.newRow)`, but **never defines `DurableJobOptions`**, what `batchJobs.record(...)` returns, how the plugin recognizes a durable job, or what it persists. Meanwhile the real system has a fully-formed durability model the amendment must preserve:

```js
// runARBatchV2.js — current durable CONSUMER (the pattern `durable` replaces)
const { batchJob, log } = require('@hopdrive/batchjobs');
module.exports = {
  runARBatchV2: batchJob(async (_event, hasuraEvent, options) => {
    const { batchJob } = options;        // the batch_jobs ROW
    const input = batchJob.input || {};  // the persisted work payload
    log(`Processing ar_v2 job #${batchJob.id} ...`);   // log() → batch_jobs.output (circular-ref-safe)
    ...
  }),
};
```

`batch_jobs` row shape (from `@hopdrive/batchjobs` types): `{ id, batch_id?, delay_ms?, delay_key?, sequence?, type?, status, input, output, created_at, updated_at }`.
`BatchJobStatus = 'pending' | 'ready' | 'delaying' | 'processing' | 'done' | 'error' | 'timeout'`.

The planning conversation's decision (redesign chat ~1770-2013) was explicit: **job code MUST stop calling `batchJob(...)` to get lifecycle behavior.** Lifecycle (status transitions, error trapping, log persistence, timeout handling) becomes plugin-driven via EventKit's hooks; the job just reads its record off `ctx`. This amendment specifies that contract.

### Decision: two distinct durability concerns, kept separate
The current AR system already separates them, and EventKit MUST preserve the split:

1. **Durable execution (consumer side).** An invocation triggered by a `batch_jobs` row runs a job whose lifecycle is **persisted to that row**. This is what `batchJob(...)` does today; `durable` replaces the wrapper.
2. **Enqueue (producer side).** A normal job persists a *new* `batch_jobs` row for later execution. This is an ordinary DB side-effect that the Hasura source picks up on a subsequent invocation — it is **not** a separate source (per the conversation's explicit rejection of "batchjobs as a source adapter"). It gets a thin helper, not the `durable` flag.

### Interface: `DurableJobOptions` and the `batchJobs` factory surface

```ts
/** Reference to the batch_jobs row backing a durable job execution. */
export interface BatchJobRef {
  id: string | number;
  type?: string;
  batchId?: string | number;
}

/** Value of JobOptions.durable when a job's execution is backed by a persisted record. */
export interface DurableJobOptions {
  /** The batch_jobs row this execution is bound to (consumer side). */
  record: BatchJobRef;
  /** Persist ctx.log output to batch_jobs.output. Default: true. */
  persistLogs?: boolean;
  /** Persist the job's return value to batch_jobs.output. Default: true. */
  persistOutput?: boolean;
  /** Status to set on the row when the job exhausts retries without success.
   *  Default: 'error'. */
  terminalFailureStatus?: Extract<BatchJobStatus, 'error' | 'timeout'>;
}

export type BatchJobStatus =
  | 'pending' | 'ready' | 'delaying' | 'processing' | 'done' | 'error' | 'timeout';

/** The batchjobs plugin's public factory surface, imported in event modules. */
export interface BatchJobsApi {
  /** Bind a job's execution to the batch_jobs row that triggered this invocation. */
  record(ref: BatchJobRef | HasuraRow): DurableJobOptions;

  /** Producer side: enqueue a NEW batch_jobs row for later execution.
   *  Returns a job result value, NOT DurableJobOptions — call it inside a normal job. */
  enqueue(spec: EnqueueSpec): Promise<BatchJobRef>;

  /** Detector helpers scoped to batch_jobs row conventions (RFC §12). */
  detector: {
    created(ctx: HasuraDetectorContext): boolean;
    triggerType(ctx: HasuraDetectorContext, type: string): boolean;
  };
}

export interface EnqueueSpec {
  type: string;                       // routes to the consumer event module
  input: Record<string, unknown>;     // MUST be serializable — becomes batch_jobs.input
  delayMs?: number;                   // batch_jobs.delay_ms
  delayKey?: string;                  // batch_jobs.delay_key — dedupe key (e.g. SDK arDedupeKey)
  sequence?: number;
  batchId?: string | number;
}
```

### `JobContext` extension for durable jobs (the `ctx.batch` channel)
The durable record reaches the job through a typed context extension (the same source/plugin augmentation mechanism Amendment B introduces for handlers), **not** through the options bag:

```ts
export interface DurableJobContext<TInput = undefined, TRow = Record<string, unknown>>
  extends JobContext<TInput> {
  batch: {
    record: BatchJobRecord<TRow>;   // the full batch_jobs row, incl. its persisted `input`
  };
}
export interface BatchJobRecord<TRow = Record<string, unknown>> {
  id: string | number;
  type?: string;
  status: BatchJobStatus;
  input: TRow;                       // the persisted work payload (was options.batchJob.input)
  attempt: number;
  maxAttempts: number;
}
```

### Persisted lifecycle (normative — the contract the plugin MUST honor)
The BatchJobs plugin observes EventKit's existing lifecycle hooks (§11) for any job whose `options.durable` is set, and maps them onto `batch_jobs` state:

| EventKit hook | batch_jobs effect |
|---|---|
| `onJobStart` | set `status='processing'`, stamp `started_at`, record `attempt` |
| `onJobLog` (when `persistLogs`) | buffer; flush to `output` (circular-ref-safe, see below) |
| `onJobEnd` (success) | set `status='done'`, write `output` (when `persistOutput`), stamp `completed_at` |
| `onJobEnd` (failure, attempts remain) | set `status='delaying'` then `'ready'` per retry schedule; record error |
| `onJobEnd` (failure, attempts exhausted) | set `status=terminalFailureStatus` (default `'error'`), persist serialized error |
| timeout / `signal` abort | set `status='timeout'`, flush partial `output` |

Normative requirements:
- The plugin **MUST** read only serializable data (`ctx.job.metadata`, `ctx.batch.record.input`) when writing `batch_jobs`. It **MUST NOT** read `ctx.input` (Amendment A) — that channel is live/non-persisted by definition.
- Before writing `output`, the plugin **MUST** apply circular-reference replacement equivalent to today's `BatchJobLogger.replaceCircularReferences` (the planning decision to move `serializeError`/`serializeOutput`/`replaceCircularReferences` into core, LOST-7, applies here).
- **Retry ownership (ADR-008):** EventKit core decides *whether* a retry happens (`JobOptions.retries`, attempt counting, the `'failed'`→retry decision). BatchJobs *persists* attempt state and *schedules* the delayed attempt (`status='delaying'` + `delay_ms`, then `'ready'`). Core owns the meaning; the plugin owns the durable state. The two MUST agree on `attempt`/`maxAttempts`, which are surfaced on both `JobExecution` and `BatchJobRecord`.
- The plugin **MUST** be best-effort with respect to business execution failures of its *own* writes: a failed `batch_jobs` status write SHOULD be logged and surfaced but MUST NOT crash the job (consistent with §11 observability guidance).

### Migration mapping — the durable consumer
```ts
// before — execution wrapper in job code
const { batchJob, log } = require('@hopdrive/batchjobs');
module.exports = {
  runARBatchV2: batchJob(async (_event, hasuraEvent, options) => {
    const { batchJob } = options;
    const input = batchJob.input || {};
    log(`Processing ar_v2 job #${batchJob.id} ...`);
    return await runArWorkUnit(toWorkUnit(input));
  }),
};

// after — plain job; lifecycle is plugin-driven; record comes off ctx
export const runARBatchV2 = async (ctx /* : DurableJobContext */) => {
  const input = ctx.batch.record.input || {};
  ctx.log.info(`Processing ar_v2 job #${ctx.batch.record.id}`);
  return await runArWorkUnit(toWorkUnit(input));
};

// handler binds the job to the triggering row
export const handler = hasura.handler<BatchJobRow>(async (event, ctx) => {
  return run(event, [
    job(runARBatchV2, {
      durable: batchJobs.record(ctx.newRow),   // DurableJobOptions
      retries: 3,
      timeoutMs: 120_000,
    }),
  ]);
});
```

### Migration mapping — the enqueue producer
```ts
// before — runARV2 inserts ar_v2 batch_jobs rows directly via sdk/gql
// after — same job, using the typed helper; still an ordinary job side-effect
export const runARV2 = async (ctx /* JobContext */) => {
  const { moveId, eventKey, sdk, user } = ctx.input;     // live deps via Amendment A
  for (const trigger of matchingTriggers) {
    await batchJobs.enqueue({
      type: 'ar_v2',
      input: { algorithm, context, createdBy: user },     // serializable → batch_jobs.input
      delayKey: arDedupeKey({ algorithm, context }),       // dedupe
    });
  }
};
```

This keeps the existing AR invariant intact (enqueue and consume remain separate invocations, separate batch_jobs, separate failure semantics) while removing the `batchJob(...)` wrapper from consumer code and the options-bag dependency from both sides.

---

## Summary of normative changes to fold into the RFC

| RFC section | Change |
|---|---|
| §9 `RunOptions` / §10 | Pin `mode` default `'parallel'`, `continueOnFailure` default `true`; state that `series`/stop-on-failure is opt-in and does **not** preserve current behavior. |
| §9 `JobOptions.durable` | Replace bare `DurableJobOptions` reference with the defined interface; `durable` backs *execution* with a record (consumer), distinct from enqueue (producer). |
| §12 BatchJobs | Define `BatchJobRef`, `DurableJobOptions`, `BatchJobsApi` (`record`/`enqueue`/`detector`), `DurableJobContext.batch.record`, the `BatchJobStatus` enum, and the persisted-lifecycle hook→status table. State the retry-ownership split (ADR-008) concretely. Move `serializeError`/`serializeOutput`/`replaceCircularReferences` into core and require circular-ref-safe `output` writes. |
| §11 | Note that the durable plugin is the canonical consumer of the existing lifecycle hooks; its own write failures are best-effort. |

Together with Amendments A–C, this gives the four production-critical seams — data channel, handler source data, per-invocation entry, and durable execution — concrete, type-checked contracts, and turns the batch-job migration from "rewrite every consumer's wrapper" into "delete the wrapper, read the record off `ctx`."
