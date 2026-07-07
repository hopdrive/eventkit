# hopdrive-eventkit

## 0.4.1

### Patch Changes

- 4d3efd3: **Fix silent terminal-state loss on the observability final flush** — a `job_executions`
  row could stay `running` with `duration_ms: null` after its invocation already read
  `completed`. The final flush deleted the per-invocation buffer BEFORE awaiting the sink and
  swallowed any error, so a partial batch (the invocations mutation lands, then the
  events/jobs mutation throws a deterministic GraphQL-level error, which is never retried)
  permanently and silently lost the job's terminal state.

  Three defenses:

  - **`flush()` no longer discards state before it's durable** — the buffer is deleted only
    AFTER the sink resolves. A failed final flush now RETAINS the buffer, so `onFlush` (which
    runs in the same `handle()` `finally`, right after `onInvocationEnd`) retries the terminal
    write instead of dropping it.
  - **Sink failures are surfaced, not swallowed** — new `onSinkError?(err, { invocationId,
final })` option on `observability(...)`, defaulting to a `[eventkit]` `console.warn`.
    Ignored under `strict` (the error is rethrown as before). Silent telemetry loss was the
    worst failure mode for a telemetry system.
  - **`graphqlSink` graceful-degrades an events/jobs GraphQL error** — a deterministic
    `GraphqlResponseError` on the `job_executions`/`event_executions` mutation retries ONCE
    with the droppable payload columns shed (`result`, `job_options`, error stacks), mirroring
    the existing `source_job_id` degrade, so the row lands lossy-but-terminal (`status`
    preserved) rather than being lost entirely.

  Additive and backward-compatible: `onSinkError` defaults to the console warning, and the
  sink degrade only triggers on a mutation that would otherwise have thrown.

## 0.4.0

### Minor Changes

- 7cb7ed3: **Add a kit-level `prepare` → `ctx.provided`** — a first-class, once-per-invocation context
  provider, so sharing a live ref (a GraphQL executor, an authenticated vendor client, a
  resolved tenant config) across an invocation no longer requires hand-rolling an
  `augmentJobContext` plugin.

  Declare it as a reserved key on `createEventKit`'s config:

  ```ts
  const kit = createEventKit(hasuraEvent, {
    prepare: () => ({ executor: createFetchExecutor({ url, adminSecret }) }),
  })
    .use(netlifyV2Platform)
    .registerEvents(events);
  ```

  It runs **once per invocation** (after `normalize`, before detection) and its returned
  object is attached as `ctx.provided` — the SAME instance — on **every detector, module
  `prepare`, and job** of that invocation.

  - **Request-scoped, never serialized.** Unlike `envelope.meta` (persisted to observability),
    `provided` is safe for live objects. Defaults to `{}` when unset.
  - Distinct from the existing scopes: kit `prepare` → `ctx.provided` (per **invocation**,
    whole stack); module `prepare` → `ctx.input`/`ctx.prepared` (per **event**); per-job
    `input` (per **job**, merges highest).
  - Also runs under `dryRun` so detectors that read `ctx.provided` behave identically — keep it
    cheap. A throw aborts the invocation cleanly, reported as the new `ErrorPhase` value
    `'prepare'`; no jobs run.

  New public types: `KitPrepareContext`, `KitPrepareFunction`. `DetectorContext`,
  `HandlerContext`, `InvocationContext`, and `JobContext` gain a `provided: Record<string,
unknown>` field. Additive and backward-compatible (`provided` is `{}` when no kit `prepare`
  is configured).

## 0.3.0

### Minor Changes

- a1763eb: Netlify Functions 2.0 support + observability lineage fix (surfaced by the hoprides v2 migration).

  **Add `netlifyV2BackgroundPlatform`** — the modern Netlify v2 `(Request, Context) → Response`
  shape for a function declared `export const config = { background: true }` (no `-background`
  filename suffix). It reuses `netlifyV2Platform`'s Web-Request plumbing but runs as a
  deferred-response platform: `deferredResponse: true` (blocks result-driven `respond` modules),
  a ~15-minute default budget, and a `202` `Response`. Import from `hopdrive-eventkit/platforms`.

  **Fix orphaned observability origins** — the plugin buffered a job's `job_execution` row in the
  parent invocation's memory and only flushed it at invocation end. A long-running job's DB
  write-backs spawned child invocations (in separate processes) that hit the sink before the
  parent flushed, so their `source_job_id` FK failed and the sink's graceful-degrade silently
  dropped the link — rendering them as false extra "origins" in the console flow graph. The job's
  row is now persisted (status `running`) during `onJobStart`, before the job body runs (the
  runtime awaits `onJobStart`), so the parent row is durable before any side effect can spawn a
  child. Idempotent (sink upserts); gated by a new `persistJobsAtStart` option (default true).

  **Preserve `rawBody` on the v2 platforms** (surfaced by the sparkserv migration) — the webhook
  source's HMAC `verify` needs the exact request bytes, but `netlifyV2Platform`/
  `netlifyV2BackgroundPlatform` consumed the body via `req.json()` and never exposed `rawBody`, so
  signature verification always failed on v2. The adapters now read the Web `Request` body once as
  text, cache the exact bytes (WeakMap, no mutation of the Request), return the parsed JSON as the
  payload, and expose the bytes as `request.meta.rawBody`. Backward-compatible (rawBody was simply
  absent before); JSON parsing tolerates a non-JSON body (returns the raw string).

  **Drop the `uuid` dependency** (surfaced by the event-handlers migration) — the runtime used
  it only for v4 generation, and uuid v14 is ESM-only: the CJS build carried a nested copy that
  `require()` refuses at runtime (ERR_REQUIRE_ESM under netlify dev) and Jest consumers cannot
  parse without a moduleNameMapper. `crypto.randomUUID()` (built into Node ≥20, browsers, and
  workers) replaces it; eventkit now has zero runtime dependencies.

## 0.2.1

### Patch Changes

- c5d3657: Docs & tooling housekeeping after the npm rename to `hopdrive-eventkit`:

  - Correct all README and `docs/guide.html` import/install examples to the published
    name (`hopdrive-eventkit`, e.g. `import { … } from 'hopdrive-eventkit/plugins'`) so
    copy-paste works for consumers.
  - Derive the `docs-compile` doc-drift gate's scan regex from `package.json` "name"
    instead of a hardcoded scope, so a future rename can't silently turn the gate into a
    zero-match no-op. The gate now validates 50 documented import names again.
  - Console app: bump `jsondiffpatch` 0.6.2 → 0.7.2 (Dependabot; dev-only, not part of the
    published package).
