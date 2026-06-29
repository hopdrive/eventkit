# EventKit RFC — Proposed Amendment: the three load-bearing seams

**Date:** 2026-06-28
**Status:** Proposed amendment to `EventKit Architecture RFC.md`
**Scope:** Resolves the three blocking gaps identified in `EventKit-design-evaluation-202606281700.md`:
- **Amendment A** — the handler→job **data channel** (`input`) — resolves evaluation LOST-1 / review #1, #2.
- **Amendment B** — **`HasuraHandlerContext`** and the source handler-context contract — resolves LOST-4 / review #4.
- **Amendment C** — **`runtime.handle()` + `InvocationContext`** + per-request config — resolves LOST-5 / review #9, and gives the tracking-token loop-prevention mechanism (LOST-2) a concrete home.

All three are grounded in the real consumer code they must replace:
`functions/db-moves/events/move.pickup.started.js`, `functions/~lib/scoped-job.js`, `functions/db-moves/db-moves.js`, `functions/~lib/jobs/runARV2.js`.

Normative language: **MUST / SHOULD / MAY** per RFC §"How to Use This Document".

---

## Amendment A — The `job()` data channel: `input` (live, non-persisted) vs `metadata` (serialized)

### Problem this fixes
Today the second argument to `job()` is simultaneously execution config **and** the business-data bag handed to the job as its third parameter:

```js
// move.pickup.started.js — current
job(runARV2, { moveId: dbEvent?.new?.id, eventKey: MOVE_PICKUP_STARTED_EVENT_KEY, sdk, user, role })
job(publishGenericWebhook, { sdk, hasuraEventTime, delaySeconds: 2,
    getWebhookData: (...args) => getMoveWebhookData(...args, dbEvent?.new?.id),  // closure
    getCustomerId: () => dbEvent?.new?.customer_id })                            // closure
// runARV2.js — current
async (event, hasuraEvent, options) => { const { sdk, eventKey, user } = options; ... }
```

This bag routinely carries **non-serializable** values: live `sdk`/apollo clients and closures. EventKit's `JobOptions` is a closed config shape whose `metadata` is **persisted by BatchJobs and recorded by Observability** — there is nowhere safe to put live clients or closures, and routing them through `metadata` would crash or silently corrupt durable/observability writes.

### Decision
EventKit MUST provide two distinct, separately-typed channels on a job definition:

- **`input`** — request-scoped data the handler hands to the job. The runtime **MUST NOT** serialize, persist, log, or transmit `input`. It MAY contain live clients, closures, and `old`/`new` rows. It is the migration target for today's options bag.
- **`metadata`** — serializable, durable annotations. BatchJobs persists it; Observability records it. It **MUST** be JSON-serializable. The runtime MAY redact it.

`job(fn, options)` keeps its two-argument shape. `input` is a typed field on options; the job reads it at `ctx.input`.

### Interface changes (replaces RFC §9 `job`, `JobOptions`, `JobContext`)

```ts
export interface JobOptions<TInput = undefined> {
  name?: string;
  timeoutMs?: number;
  retries?: number;
  tags?: string[];
  continueOnFailure?: boolean;
  durable?: boolean | DurableJobOptions;

  /** Request-scoped data handed to the job. NEVER persisted, logged, or serialized.
   *  Live clients, closures, old/new rows belong here. */
  input?: TInput;

  /** Serializable annotations. Persisted by BatchJobs, recorded by Observability.
   *  MUST be JSON-serializable. */
  metadata?: Record<string, unknown>;
}

export type JobFunction<TInput = undefined, TResult = unknown> =
  (ctx: JobContext<TInput>) => Promise<TResult> | TResult;

export function job<TInput = undefined, TResult = unknown>(
  fn: JobFunction<TInput, TResult>,
  options?: JobOptions<TInput>,
): JobDefinition<TInput, TResult>;

export interface JobContext<
  TInput = undefined,
  TPayload = unknown,
  TMeta = Record<string, unknown>,
> {
  invocationId: string;
  correlationId: string;
  event: DetectedEvent<TPayload, TMeta>;
  envelope: EventEnvelope<TPayload, TMeta>;

  /** Typed, request-scoped data supplied via JobOptions.input. */
  input: TInput;

  job: {
    id: string;
    name: JobName;
    attempt: number;
    options: JobOptions<TInput>;
    /** serializable metadata only — never the live `input` */
    metadata: Record<string, unknown>;
  };

  log: JobLogger;
  progress(value: number, metadata?: Record<string, unknown>): Promise<void>;
  checkpoint(name: string, metadata?: Record<string, unknown>): Promise<void>;
  signal?: AbortSignal;
}
```

### Normative requirements
- The runtime **MUST** pass `options.input` through to `ctx.input` by reference without cloning or serializing it.
- BatchJobs and Observability **MUST** read only `ctx.job.metadata` (and `options.metadata`), and **MUST NOT** read, persist, or log `ctx.input`.
- When `durable` is set, the runtime **MUST** assert that `metadata` is serializable and **SHOULD** fail fast (at `job()` registration where possible) if a non-serializable value is placed in `metadata`. This makes the "don't persist live clients" rule a compile/early-runtime error instead of a production corruption.
- `input` defaults to `undefined`; jobs with no per-call data keep the zero-config `job(fn)` form.

### Migration mapping
```ts
// before
job(runARV2, { moveId: dbEvent?.new?.id, eventKey: MOVE_PICKUP_STARTED_EVENT_KEY, sdk, user, role })
async (event, hasuraEvent, options) => { const { sdk, eventKey, user } = options; }

// after
job(runARV2, {
  input: { moveId: ctx.newRow?.id, eventKey: MOVE_PICKUP_STARTED_EVENT_KEY, sdk, user, role },
  metadata: { eventKey: MOVE_PICKUP_STARTED_EVENT_KEY },   // optional: only the serializable bits you want traced
});
async (ctx) => { const { sdk, eventKey, user } = ctx.input; }
```

Closures and live clients (`getWebhookData`, `getCustomerId`, `sdk`) move into `input` unchanged — they are never serialized, so the durability/observability conflict disappears. This is a mechanical, type-checked port across all ~40 jobs and 245 modules, not a redesign of each one.

> **Why not reuse `metadata` for everything?** Because the whole point of the rewrite is durable + observable jobs; `metadata` is the thing that gets written to `batch_jobs` and the observability tables. Conflating live request data with persisted annotations is exactly the bug that makes the current options bag incompatible with durability. The two channels MUST stay separate.

---

## Amendment B — `HasuraHandlerContext` and the source handler-context contract

### Problem this fixes
ADR-007 ("DetectedEvent does not carry DetectorContext") is correct and stays. But the RFC's generic `HandlerContext` (§9) has **no source data at all** — no `operation`, no `oldRow`/`newRow`, no session-derived `role`/`user`/event-time. Real handlers depend on all of it:

```js
// move.pickup.started.js — current handler
const { dbEvent, hasuraEventTime, role, user } = parseHasuraEvent(hasuraEvent);
... isDriverStatusActionable(dbEvent?.old?.driver_status, dbEvent?.new?.driver_status)  // old vs new
... job(sendDriverSilentPushNotification, { oldMove: dbEvent?.old, newMove: dbEvent?.new, sdk })  // 14 sites need old
```

The planning conversation already designed the fix; it was dropped in the export. This amendment restores it.

### Decision
A `SourceAdapter` MAY contribute a typed, source-specific **handler context extension**. The base `HandlerContext` stays generic and source-agnostic; the source that normalized the envelope (and therefore already parsed `old`/`new`/`operation`) is the owner that enriches it. Detector-only helpers (`columnChanged()`) **MUST NOT** appear on handler context — only source *data*, not source *detection helpers*.

### Interface changes (extends RFC §7 SourceAdapter contract, §9 HandlerContext)

```ts
export interface SourceAdapter<
  TPayload = unknown,
  TDetectorCtx = unknown,
  THandlerExt = {},
> {
  name: EventSourceName;
  sourceType: EventSourceType;
  normalize(raw: unknown, request: RequestContext): EventEnvelope<TPayload>;
  buildDetectorContext(envelope: EventEnvelope<TPayload>, base: DetectorContext<TPayload>): TDetectorCtx;
  /** NEW: enrich the handler context with source DATA (never detection helpers). */
  buildHandlerContext?(envelope: EventEnvelope<TPayload>, base: HandlerContext<TPayload>): THandlerExt;
}

/** Hasura source handler context — DATA only, no columnChanged(). */
export interface HasuraHandlerContext<TNewRow = Record<string, unknown>, TOldRow = TNewRow>
  extends HandlerContext<HasuraEventPayload<TNewRow>> {
  operation: HasuraOperation;          // 'INSERT' | 'UPDATE' | 'DELETE' | 'MANUAL'
  oldRow: TOldRow | null;
  newRow: TNewRow | null;
  /** session/source-derived, not business logic */
  role: string | null;
  userId: string | null;
  userEmail: string | null;
  receivedAt: Date;                    // replaces parseHasuraEvent().hasuraEventTime
}
```

The handler is typed through the source, symmetric with the detector:

```ts
export const detector = hasura.detector<MoveRow>((ctx) => { ... });          // unchanged
export const handler  = hasura.handler<MoveRow>(async (event, ctx) => { ... }); // ctx: HasuraHandlerContext<MoveRow>
```

### Normative requirements
- `HasuraHandlerContext` **MUST** expose `operation`, `oldRow`, `newRow`. Handlers that compare old vs new (driver-status transitions, silent-push diffs) depend on it.
- It **MUST NOT** expose `columnChanged()`, `columnAdded()`, or other detection helpers — that distinction is the legitimate core of ADR-007.
- `role`/`userId`/`userEmail`/`receivedAt` are source-level (Hasura session variables + delivery time), not HopDrive business rules, so they belong on the source handler context. Move-domain helpers (`isMoveOperationallyDone`) stay in the app repo per §3.3.
- For a `DELETE`, `newRow` is `null` and `oldRow` is populated; for `INSERT`, the reverse. The adapter **SHOULD** also provide a `row = newRow ?? oldRow ?? null` convenience accessor.

### Migration mapping
```ts
// before
module.exports.handler = async (eventName, hasuraEvent) => {
  const { dbEvent, hasuraEventTime, role, user } = parseHasuraEvent(hasuraEvent);
  const actionable = isDriverStatusActionable(dbEvent?.old?.driver_status, dbEvent?.new?.driver_status);
  return run(eventName, hasuraEvent, [ ... ]);
};

// after
export const handler = hasura.handler<MoveRow>(async (event, ctx) => {
  const { oldRow, newRow, role, receivedAt } = ctx;
  const actionable = isDriverStatusActionable(oldRow?.driver_status, newRow?.driver_status);
  return run(event, [ ... ]);
});
```

---

## Amendment C — `runtime.handle()`, `InvocationContext`, and per-request config

### Problem this fixes
The RFC stops at `createEventKit({...})`. It references `InvocationContext` in plugin-hook signatures (RFC line 568) but never defines it, and never shows the per-invocation function that replaces `listenTo()`. The current entry point also carries per-request config the RFC has no channel for:

```js
// db-moves.js — current, runs on EVERY invocation
const { invocationId } = logger.getLabels();
pluginManager.register(new TrackingTokenExtractionPlugin({ extractFromUpdatedBy: true }));   // re-registers per call
pluginManager.register(new ObservabilityPlugin({ graphql: { headers: { 'x-hasura-client-name': 'ObservabilityPlugin-db-moves' }}}));
pluginManager.register(new GrafanaLoggerPlugin());
await listenTo(hasuraEvent, { invocationId, eventModules: [...] });
```

Two defects this also closes: plugins **re-register on every warm-lambda invocation** (a latent leak), and per-function config (`invocationId`, `x-hasura-client-name`) is wired by re-instantiating plugins per request.

### Decision
`createEventKit()` runs **once at module scope** and returns an `EventKit` with a per-invocation `handle()` method. Per-request data flows through a `RequestContext` argument to `handle()` and reaches plugins via `InvocationContext` — replacing both per-invocation plugin registration and the current `onPreConfigure` mutation hook.

### Interface additions (new RFC §9 entry point + §11 hook context)

```ts
export interface EventKit {
  handle(rawPayload: unknown, request?: RequestContext): Promise<InvocationResult>;
  shutdown(): Promise<void>;
}

export function createEventKit(config: EventKitConfig): EventKit;   // module scope, once per process

export interface RequestContext {
  invocationId?: string;                 // override; runtime generates one if absent
  correlationId?: string;                // else derived from source (e.g. Hasura trace_context) or generated
  sourceFunction?: string;               // e.g. 'db-moves' — used for client-name + observability attribution
  getRemainingTimeMs?: () => number;     // serverless budget; runtime derives the AbortSignal from this
  pluginConfig?: Record<string, Record<string, unknown>>;  // optional per-request plugin overrides, keyed by plugin name
  meta?: Record<string, unknown>;
}

/** The previously-undefined type referenced by onInvocationStart/End. */
export interface InvocationContext<TPayload = unknown, TMeta = Record<string, unknown>> {
  invocationId: string;
  correlationId: string;
  sourceFunction?: string;
  source: EventSourceName;
  sourceType: EventSourceType;
  envelope: EventEnvelope<TPayload, TMeta>;
  request: RequestContext;               // carries per-request config to every plugin
  startedAt: Date;
  signal: AbortSignal;                   // fires on serverless-budget exhaustion or shutdown
  log: InvocationLogger;
}

export interface InvocationResult {
  ok: boolean;
  invocationId: string;
  events: Array<{ name: EventName; detected: boolean; jobs: JobExecution[] }>;
  durationMs: number;
  timedOut?: boolean;
  error?: SerializedError;
}
```

### Per-request config: how plugins receive it (replaces `onPreConfigure`)
- Plugins are constructed **once** at `createEventKit`. They receive per-request data on `onInvocationStart(ctx: InvocationContext)` and read `ctx.invocationId`, `ctx.sourceFunction`, `ctx.request.pluginConfig?.[this.name]`.
- ObservabilityPlugin derives its client name from `ctx.sourceFunction` (`ObservabilityPlugin-${ctx.sourceFunction}`) instead of being re-instantiated per function. This **eliminates** the per-invocation `pluginManager.register(...)` calls entirely.
- A plugin that must rewrite config **before** detection MAY implement an explicit, typed hook — the sanctioned replacement for today's `onPreConfigure` options mutation:
  ```ts
  onConfigureInvocation?(request: RequestContext, envelope: EventEnvelope): RequestContext | void;
  ```
  This returns a new `RequestContext` rather than mutating a shared object, satisfying RFC §11's "no mutation as the primary integration model."

### Netlify handler after migration
```ts
// module scope — built ONCE per warm lambda
const kit = createEventKit({
  sources: [hasura()],
  plugins: [trackingToken({ extractFromUpdatedBy: true }), observability({ transport: 'graphql', graphql: {...} }), grafana()],
  events: [movePickupStarted, /* ... */],
});

export const handler = async (event, context) => {
  if (event?.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!auth.hasValidPassphrase(event)) return { statusCode: 401, body: 'Unauthorized!' };

  const { invocationId } = logger.getLabels();
  const result = await kit.handle(JSON.parse(event.body), {
    invocationId,
    sourceFunction: 'db-moves',
    getRemainingTimeMs: () => context.getRemainingTimeInMillis(),
  });

  return { statusCode: result.ok ? 200 : 500, body: JSON.stringify({ success: result.ok }) };
};
```

### Loop-prevention / tracking-token mechanism (closes LOST-2, enabled by C)
The entry point is the correct home for the loop-prevention contract the RFC currently leaves implicit:

- **Inbound:** the Hasura source adapter (or a `trackingToken` plugin at `onInvocationStart`) **MUST** extract the provenance token from `updated_by` and surface it at `envelope.meta.sourceTrackingToken`. Detectors and handlers MAY read it to suppress self-triggered work.
- **Outbound:** the runtime **MUST** make a deterministic token available at `ctx` for jobs that write to the DB: `trackingToken = ${source}.${correlationId}.${ctx.job.id}`. Jobs stamp it into `updated_by` so the next invocation recognizes the write as system-originated.
- **MANUAL:** the Hasura detector context **MUST** expose `manuallyInvoked()` (RFC §8 currently lists only `inserted/updated/deleted`). Modules that today do `case 'MANUAL': return false` port to `if (ctx.manuallyInvoked()) return false`. Without this helper, console edits silently begin firing events that are suppressed today.

This makes loop prevention a **specified control mechanism** (provenance in → token out → recognized next time), not just a field in the observability record.

### How the three amendments retire `scoped-job.js`
`functions/~lib/scoped-job.js` exists only to (1) read the plugin-injected `opts.jobExecutionId`, (2) build a log scope from it, and (3) attach a tracking token to `opts`. With these amendments:
- `ctx.job.id` is available **inside** the job (Amendment A), so the log scope no longer needs a `job()`-time wrapper reading a mutated options field.
- The tracking token is provided on `ctx` by the runtime (Amendment C), not generated in a wrapper.
- Per-request correlation comes from `InvocationContext`, not from mutating the options bag.

`scoped-job` collapses into a thin `ctx.log` scope (or disappears), and the options-mutation channel RFC §11 deprecates is no longer load-bearing.

---

## Summary of normative changes to fold into the RFC

| RFC section | Change |
|---|---|
| §9 `JobOptions` | Add `input?: TInput` (non-persisted) alongside `metadata` (serialized); make `job()`/`JobContext`/`JobFunction` generic over `TInput`; job fn signature becomes `(ctx) => …`. |
| §9 `JobContext` | Add `input: TInput`; clarify `job.metadata` is serializable-only. |
| §9 / §11 | Define `EventKit.handle(payload, request)`, `RequestContext`, `InvocationContext`, `InvocationResult`; `createEventKit` is module-scope/once. |
| §7 SourceAdapter | Add optional `buildHandlerContext()`; define `HasuraHandlerContext` (data only, no detection helpers). |
| §8 Detector API | Add `manuallyInvoked()` to the Hasura detector context. |
| §11 Plugins | Replace `onPreConfigure`-style mutation with `onConfigureInvocation(request, envelope): RequestContext`; specify plugins read per-request data from `InvocationContext`. |
| §13 Observability | Specify the inbound/outbound tracking-token contract for loop prevention (not just the record field). |
| §10 `RunOptions` | (from evaluation LOST-3, recommended alongside) pin defaults `mode:'parallel'`, `continueOnFailure:true` for migration parity. |

These resolve review items #1, #2, #4, #6, #9 and evaluation LOST-1, -2, -4, -5, -6 with concrete, type-checked contracts, and convert the migration of handlers/jobs from a per-file redesign into a mechanical port.
