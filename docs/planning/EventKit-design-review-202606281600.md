I'll start by reading the RFC document and exploring the codebase structure in parallel.

Let me extract the RFC document content from https://docs.google.com/document/d/18Qk0-fufGjF-46hPvLR-wF7Iq-QJ5vdyY4-F5_odgtI

I have the full RFC. Now let me explore how the current `hasura-event-detector` is actually consumed in the codebase.

Now let me explore the actual event modules, handlers, and jobs in the codebase to understand real usage patterns.

This is a large codebase (~250 event modules). Let me read the key consumption patterns: the entry points, a representative event module, and the lib helpers.

This is extremely informative. The current `job(fn, optionsObject)` passes **business data** as the second arg, which is fundamentally different from EventKit's `JobOptions`. Let me dig into jobs, batchjobs (durable), cron/webhook handlers, and the observability plugin usage.

Let me look at a job implementation's signature, a cron handler, a webhook handler, and the grafana plugin to understand the full consumption surface.

Let me examine the installed package's actual API and a cron + webhook handler to confirm the current contract.

Webhooks/crons are bespoke; the package is consumed by `db-*` handlers (245 event modules). Let me confirm a few specific patterns: the template, a detector test, and the multi-`run` handler.

I have a thorough picture. Let me verify two specific behaviors that produce concrete findings: the conditional falsy-job-in-array pattern, and the tracking-token / jobExecutionId injection channel.

I now have everything I need: the RFC, and concrete evidence of how the current package is consumed across 245 event modules. Here is my evaluation.

---

# EventKit migration evaluation — event-handlers

I read the RFC end-to-end and traced how `@hopdrive/hasura-event-detector@2.3.6-rc2` is actually consumed here: 245 event modules under `functions/db-*/events/`, ~40 shared jobs in `functions/~lib/jobs/`, the dispatch entrypoints (`functions/db-*/db-*.js`), the `scoped-job` wrapper, the Grafana plugin, and the test suite. Crons and webhooks (`webhook-stripe-payment-intent`, etc.) are bespoke and don't touch the package, so the blast radius is the `db-*` surface.

The RFC is a strong *conceptual* document. But several of its core API decisions collide head-on with how this repo actually uses the package today, and a few are self-inconsistent. Findings below are ordered by severity.

## Consumption failure modes (what breaks when we drop EventKit in)

### 1. `job(fn, options)` means two completely different things — this is the big one
Today the **second argument to `job()` is a business-data bag** that gets handed to the job function:

```js
// functions/db-moves/events/move.pickup.started.js:51-61
return await run(eventName, hasuraEvent, [
  job(publishGenericWebhook, { sdk, hasuraEventTime, delaySeconds: 2,
    getWebhookData: (...args) => getMoveWebhookData(...args, dbEvent?.new?.id),
    getCustomerId: () => dbEvent?.new?.customer_id }),
  job(handleSMSInitiation, { move: dbEvent?.new, role, user, isMultipleUpdate }),
  job(runAR,   { moveId: dbEvent?.new?.id, sdk, role, user }),
  job(runARV2, { moveId: dbEvent?.new?.id, eventKey: MOVE_PICKUP_STARTED_EVENT_KEY, sdk, user, role }),
  ...
]);
```

Jobs read it as their third parameter: `runARV2: async (event, hasuraEvent, options) => { const { sdk, eventKey, user } = options; ... }` (`functions/~lib/jobs/runARV2.js:331`).

In EventKit, `job(fn, options)` takes **`JobOptions`** — `{ name, timeoutMs, retries, tags, metadata, durable, continueOnFailure }` (RFC §9) — pure execution config. The job receives a **`JobContext`** (`event`, `envelope`, `job`, `log`, `signal`) with **no channel for arbitrary application data**. There is nowhere to put `{ sdk, move, role, user, eventKey, getWebhookData }`.

This is not a syntax port — it breaks the fundamental data-flow contract of all 245 modules and ~40 jobs, and the RFC's migration section (§19) is silent on it. The only EventKit-sanctioned channel is `JobOptions.metadata`, and that's the next problem.

### 2. The data EventKit *could* carry must be serializable — but we pass live SDK clients and closures
`JobOptions.metadata` is persisted by BatchJobs (durable payload reference, §12) and recorded by Observability (§13). The current options bags routinely contain things that **cannot be serialized**:
- live `sdk` / apollo client instances (every AR/webhook job),
- **functions**: `getWebhookData: (...) => ...`, `getCustomerId: () => ...` (`move.pickup.started.js:55-56`).

So even if we route data through `metadata`, durable jobs (`durable: batchJobs.record(...)`, RFC §12) and observability will choke on or silently drop non-serializable inputs. The "hand the job a live client + closures" idiom is architecturally incompatible with a runtime that wants to serialize, persist, and replay job inputs. The RFC never resolves this tension, and it's exactly the path AR/billing money-flows take.

### 3. `run()` signature and arity change
Current: `run(eventName, hasuraEvent, jobs)` (3 args; the raw `hasuraEvent` is threaded down to every job). EventKit: `run(event, jobs, options)` — `hasuraEvent` is gone. Anything that re-derives from the raw event downstream (e.g. `scoped-job` calling `parseHasuraEvent(hasuraEvent)`, `TrackingToken.forJob(hasuraEvent, ...)`) loses its input. Every `return await run(...)` call site (245) and the test mocks change.

### 4. Handlers need `role` / `user` / `oldRow` / event-time — EventKit deliberately strips them
216 handlers call `parseHasuraEvent(hasuraEvent)` to get `role`, `user`, `hasuraEventTime`, `dbEvent.old`, `dbEvent.new`:

```js
// invoice.closed.js:57 ; move.pickup.started.js:30,34-35
const { dbEvent, role, user } = parseHasuraEvent(hasuraEvent);
... isDriverStatusActionable(dbEvent?.old?.driver_status, dbEvent?.new?.driver_status)
```

ADR-007 throws away `DetectorContext` after detection, and the `HandlerContext` interface (§9) has **no Hasura fields at all** — no `oldRow`, no `role`/`user`, no event time, and no `parseHasuraEvent` equivalent. The RFC conflates two different things: "handlers shouldn't use *detection helpers* like `columnChanged()`" (reasonable) with "handlers shouldn't see *source data*" (not reasonable). Handlers legitimately need `old` vs `new` — e.g. `sendDriverSilentPushNotification` takes `{ oldMove: dbEvent?.old, newMove: dbEvent?.new }` (14 sites). If `envelope.payload` only carries `new`, that data is simply gone. **This is a latent correctness/data-loss bug, not just a porting cost**, and the shape of `envelope.payload` for Hasura is left unspecified.

### 5. The conditional-job idiom won't survive a typed `JobDefinition[]`
14+ handlers build the jobs array with short-circuit falsy entries:

```js
// move.pickup.started.js:61  (also move.created.js:80, all move.delivery.* etc.)
driverStatusIsActionable && !isFromDriver && !moveIsOperationallyDone && job(sendDriverSilentPushNotification, {...})
```

When the condition is false this puts literal `false` into the array. The current `run` clearly tolerates falsy entries. EventKit types `jobs: JobDefinition[]` (§9) — under the new types this won't compile, and if `run()` doesn't defensively filter, it throws at runtime on every non-matching invocation. A silent behavior change either way.

### 6. `scoped-job` depends on a mutation channel the RFC explicitly deprecates
`functions/~lib/scoped-job.js` works by having the ObservabilityPlugin **mutate the options object** (`opts.jobExecutionId`) in `onJobStart`, then reading it back out at line 34 to build the log scope and tracking token:

```js
// scoped-job.js:26-40
const trackingToken = TrackingToken.forJob(hasuraEvent, resolvedOpts, user || role || ...);
const jobExecutionId = TrackingToken.getJobExecutionId(trackingToken) || 'unknown-job-id';
resolvedOpts.trackingToken = trackingToken;
```

RFC §11 says plainly: *"Plugins should not rely on mutation of arbitrary objects as their primary integration model."* The exact mechanism this repo relies on is designed out. EventKit's replacement (`ctx.job.id` in `JobContext`) is only available *inside* the job at run time, but `scoped-job` wraps the function *before* `run()` is called, at `job()` time, when no id exists yet. The wrapper has to be rebuilt around `JobContext`, which means the whole logging-scope + correlation approach is re-architected, not ported.

### 7. `TrackingToken` is loop-prevention infrastructure with no home in EventKit
`TrackingToken.forJob` / `TrackingTokenExtractionPlugin` generate the `updated_by` provenance token so the system can recognize **its own DB writes and avoid infinite event loops** (`db-moves.js:36-38`, `scoped-job.js`). It's a `hasura-event-detector` export today. Per RFC §3.3 it's HopDrive-specific and must move to an app package — fine in principle — but it currently depends on package internals (`opts.jobExecutionId` injection, `parseHasuraEvent`, the raw `hasuraEvent`). Re-homing it onto `JobContext`/`envelope` is correctness-critical: a subtle mistake here doesn't fail a test, it produces **event storms** in production. The RFC treats it as a generic "move helpers to app packages" item and underweights the risk.

### 8. Plugin hook surface is a total rewrite, with log-coverage loss
`GrafanaLoggerPlugin` extends `BasePlugin` and implements `onLog(level, message, data, jobName, correlationId)` and `onError(error, context, correlationId)` (`grafanaLoggerPlugin.js:29,47`). EventKit's `EventKitPlugin` (§11) has **none of these** — it has `onJobLog(ctx, entry)` and `onError(ctx: ErrorContext)` with different shapes, and no `BasePlugin`. So:
- Grafana + the vendored Observability/TrackingToken plugins all rewrite against a new interface.
- More importantly, `onLog` today captures framework-internal logs at **all** levels — detection logs, plugin-system messages, **timeout handling** (per its own doc comment). EventKit only exposes `onJobLog` at *job* scope. Detector-level and plugin/runtime-level logs (including timeouts) appear to have no hook → **silent loss of Grafana coverage** for exactly the diagnostics you want during incidents.

### 9. Per-invocation plugin registration vs. `createEventKit` at startup
Each handler registers plugins per request against a **global singleton** `pluginManager`:

```js
// db-moves.js:36-51  (runs on every invocation)
pluginManager.register(new TrackingTokenExtractionPlugin({...}));
pluginManager.register(new ObservabilityPlugin({ graphql: { headers: { 'x-hasura-client-name': 'ObservabilityPlugin-db-moves' }}}));
pluginManager.register(new GrafanaLoggerPlugin());
await listenTo(hasuraEvent, { invocationId, eventModules: [...] });
```

Two problems converging:
- On a **warm lambda**, that singleton persists, so plugins **re-register on every invocation** (already a latent leak today; EventKit's model makes the boundary matter more).
- EventKit binds plugins once at `createEventKit({plugins})`. But the current config is **per-invocation**: `invocationId` comes from `logger.getLabels()` (not known at module load), and `x-hasura-client-name` differs per function. EventKit gives no documented way to inject per-invocation correlation/config into module-scoped plugins. The RFC shows `createEventKit(...)` but **never shows the per-request entry call that replaces `listenTo()`** — the function a Netlify handler actually invokes to "process this one payload." That's a missing piece of the public API (§9's pipeline stops at types).

### 10. The whole test suite is mocked against the old call shape
Many tests mock the package directly and assert on the old contract:

```js
// db-outcomes/__tests__/outcome.resolved.test.js:19-25, 88-92
const mockRun = jest.fn(async (_event, _hasuraEvent, jobs) => jobs);
jest.mock('@hopdrive/hasura-event-detector', () => ({ run: (...a)=>mockRun(...a), job: (fn, options)=>({fn,options}) }));
...
const jobs = mockRun.mock.calls[0][2];
expect(jobs[0].options.jobName).toBe('publishEventLog');
```

Detector tests call `detector('outcome.resolved', payload)` (2-arg, raw payload). EventKit detectors are `(ctx) => boolean`. Every mock (`run` arity, `job` returning `{fn,options}`, `options.jobName`) and every detector-test invocation is wrong post-migration. This is dozens of test files, and the `jobName`-via-options assertion pattern (publishEventLog is reused 37× with different `action`/`metadata`) has no clean EventKit analog.

## Design problems *in the EventKit RFC itself*

- **`JobContext` has no application-data channel (the root design miss).** §1's stated strength is "the handler hands each job exactly what it needs." EventKit removes that without a replacement, forcing either N re-fetches per job (one query per job instead of one per handler — a real latency/cost regression across 245 functions) or serialization-hostile smuggling through `metadata`. The cleanest fix would be a typed, non-persisted `input`/`deps` field on `job()` distinct from `metadata`; the RFC has no such concept.

- **`run()` default mode is left undefined "to preserve current behavior" (§10) — but never pins what that is.** Handlers like `move.pickup.started` fan out webhook + SMS + AR + ARv2; several jobs share the process-global `sdk`/apollo singleton and call `sdk.apollo.initialize`. If the default flips to parallel, you get concurrent mutation of a shared client; if it flips between series-stop-on-fail and isolated, you change outcomes. "Choose to preserve current behavior" is a non-decision in a normative spec.

- **`continueOnFailure` semantics risk a money-path regression.** §10: in series with `continueOnFailure:false`, a failed job stops the rest. Today jobs are isolated — the `outcome.resolved` "degraded mode" test asserts the fanout continues when a fetch fails. If the EventKit default is stop-on-failure, a flaky `publishGenericWebhook` could block `runAR`/`runARV2` (billing). The safe default (`continueOnFailure: true`) is the *opposite* of what §10 describes as the series default.

- **ADR-007 over-rotates.** "Discard DetectorContext after detection" is conflated with "discard source data." Correct goal (no `columnChanged()` in handlers) implemented in a way that also strips `old`/`role`/`user`. The interface should keep a typed, source-specific `envelope.payload` (with `old` and `new` for Hasura) and a handler-side accessor — the RFC defines neither concretely.

- **`MANUAL` / console operations aren't modeled.** Detectors today explicitly `switch` on `INSERT/UPDATE/DELETE/MANUAL` and return `false` for `MANUAL` (Hasura console edits) — see every module's `case 'MANUAL': return false`. EventKit's documented Hasura helpers are only `inserted()/updated()/deleted()` (§8). If `MANUAL` collapses into `updated()`, console edits could start firing events that are deliberately suppressed today.

- **Subpath exports + Netlify bundling (§17).** `@hopdrive/eventkit/sources/hasura`, `/plugins/batchjobs` rely on `exports`-map resolution through Netlify's esbuild/zisi packager and the repo's `hopdrive-inline` step (`package.json` `inline:backend`). Deep subpath exports are a classic source of "works locally, module-not-found at deploy" with serverless bundlers. The current single-import package avoids this entirely; the RFC asserts the benefit (clean scope) without addressing the bundling risk it introduces — ironic given §3.4 cites bundler determinism as the reason for explicit registration.

- **Synchronous observability in hot hooks (§13 vs §11).** §11 warns against blocking work in hot hooks; the current ObservabilityPlugin uses `transport: 'graphql'` and the proposed model writes an Invocation→Event→Job hierarchy. If `onJobStart`/`onJobEnd` are awaited (they're typed `Promise`), each job pays GraphQL round-trips on the critical path × 245 functions. The RFC needs to mandate buffer-and-flush, not just "SHOULD."

- **The compat facade (§19, phase 2) hand-waves the hardest part.** A facade can re-expose `run(eventName, hasuraEvent, jobs)` / `job(fn, dataBag)` only by reconstructing a synthetic envelope + a JobContext that smuggles the old `(eventName, hasuraEvent, options)` args — i.e. reimplementing the old runtime inside the facade. It's listed as an early, easy phase; it's actually the riskiest single component, and it still won't fix the test mocks (which import the package's internals directly).

## What's genuinely good (keep these)
- Source-agnostic `EventEnvelope` + the Invocation→DetectedEvent→JobExecution vocabulary is clean and matches the existing mental model.
- The preferred named-boolean detector style (§3.2) already *is* the house style here — see `batch.created.ar_v2.js:42-45`. Detector porting is the **lowest**-risk part.
- Keeping one detector + one handler per module preserves the current authoring experience.
- Pushing HopDrive helpers out of the framework (AR, tracking tokens, moves) is the right boundary — it just has to be sequenced carefully because tracking-token is loop-prevention.

## Recommendation
The detector layer ports cheaply; the **handler→job data contract is the migration**. Before committing, the RFC must answer three things it currently doesn't:
1. **How does a handler hand non-serializable, per-invocation data (sdk clients, closures, `old`/`role`/`user`) to a job?** Without a first-class `input`/`deps` channel on `job()`, separate from persisted `metadata`, ~285 files have no clean path and the durability/observability story actively fights the existing idiom.
2. **What is the exact per-invocation entry function** that replaces `listenTo()` in a Netlify handler, and **how is per-request config** (invocationId, client-name, correlation) injected into module-scoped plugins?
3. **What are the pinned defaults** for `run()` mode and `continueOnFailure` — stated normatively, chosen to match today's isolated fan-out, not deferred.

Until those are nailed down, I'd treat the "incremental, minimal-change" framing in §19 as optimistic: detectors are minimal-change, but handlers, jobs, `scoped-job`, the plugins, and the test suite are a rewrite, and the AR/tracking-token paths are correctness-critical enough to need shadow-mode parity testing rather than a straight cutover.

Want me to turn this into a shareable artifact/RFC-comment doc, or draft a concrete `job()` data-channel proposal (the `input` vs `metadata` split) that would unblock items 1, 2, and 6?