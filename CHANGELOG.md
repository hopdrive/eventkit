# hopdrive-eventkit

## 0.6.0

### Minor Changes

- 7b09345: Ship the observability console as a mountable component from the package: `hopdrive-eventkit/console` (plus `hopdrive-eventkit/console/style.css`).

  Instead of deploying the UI straight out of this repo (which made no sense once eventkit went open source), a consumer now stands it up with a tiny host wrapper that owns config + hosting and imports the console from the package. Scaffold one with `npx degit hopdrive/eventkit/console/template my-console`.

  - New export `EventKitConsole` takes a `config` prop (`graphqlEndpoint`, `headers`, `auth`, `basename`, `grafanaProxyPath`). Nothing reads `import.meta.env` anymore, so one built artifact runs against any endpoint.
  - Auth is injected by the wrapper. Pass `auth: { getHeaders, onUnauthenticated? }` and the console builds its Apollo client from it, resolving auth per request (a rotating JWT stays fresh without remounting). The wrapper owns login; the console owns the transport wiring.
  - The console library externalizes `react` and its React-coupled UI libs (react-router-dom, @apollo/client, reactflow, recharts, framer-motion, @heroicons, @microlink/react-json-view, @tanstack/\*, antd); the consumer's app build bundles them. Only `react` + `react-dom` are declared peers (optional), so a server/library consumer of the core installs neither. The wrapper template lists the React-coupled libs as real dependencies.
  - The Grafana Loki proxy is now a host-agnostic function (`grafanaProxyCore.ts`) with a thin Netlify adapter, so any host can serve it.

  Also folds in two console fixes carried on this branch: the `event_executions` status CHECK now allows `detection_failed`/`handler_failed` (legacy writer safety during migration), and the vite 8 / Rolldown `manualChunks` build fix.

## 0.5.0

### Minor Changes

- 76025f4: Simplification + declarative-response pass: internals consolidated, the authoring surface extended (source-scoped `defineEvent`), and the HTTP reply repositioned to the invocation layer as a self-describing declaration (breaking, pre-adoption).

  - **Removed dead export `NotImplementedError`** (root and `/core`). It was a Phase-0 scaffolding relic: no runtime code path ever threw it, so nothing could ever catch it. Migration: delete any import of it — there is no replacement because there was no behavior.
  - The three Hasura sources (`hasuraEvent`, `hasuraCron`, `hasuraAction`) now share one `callableSource` assembly helper instead of three copy-pasted factory blocks; their runtime shape (callable + attached authoring helpers + plugin `name`) is pinned by new tests.
  - `handle()` and `dryRun()` share one intake pipeline (extract → normalize → augment), and the response seams share one error-mapping path — the invocation lifecycle now reads in one place.
  - Consolidated six copies of the `crypto.randomUUID` fallback and two copies of `isJobDefinition` into single internal helpers; the two Netlify v2 platforms share the Web-`Response` rejection formatter.
  - **`webhook` factory now carries the typed authoring helpers** (additive): `webhook.detector<TBody>(fn)` / `webhook.prepare<TBody>(fn)` work on the bare factory value (uniform with the Hasura family), so an event module can type `ctx.body` without constructing the vendor-configured source that lives in the entry file. New `WebhookAuthoring` interface; runtime behavior unchanged (identity wrappers).
  - **Source-scoped `defineEvent`** (additive): every source now carries a typed module builder — `hasuraEvent.defineEvent<Row>({ … })`, `webhook.defineEvent<Body>({ … })`, `hasuraAction.defineEvent<Input>({ … })`, `hasuraCron.defineEvent<Payload>({ … })`. The one type parameter on the outer call types every inline `(ctx) => …` seam (`detector`, `prepare`) with the source's enriched context, so detectors can be authored inline with no per-seam wrapper. At runtime it is core `defineEvent` (name branding only). New core type `SourceEventModule` (type-only). The generic root `defineEvent` is unchanged and remains the full-inference path (`ctx.prepared` from `prepare`, D32).
  - **BREAKING (pre-adoption): the HTTP reply moved to the invocation layer — `kit.handler({ before, after })`** (ADR-026, re-amended). A module never declares an HTTP reply: modules own detection + jobs; one invocation has ONE wire reply and the handler declares it. `after` takes one of two self-naming modes: `{ body }` (a constant — data, not code, so it provably cannot wait on or be changed by the work) or `{ fromResults: (result) => body }` (arbitrary business logic over the PRESCRIBED typed rollup the runtime builds — `InvocationResult` with every detector's `EventOutcome` and every job's `JobExecution`; throw `ClientError`/`ActionError` for the error mapping). Optional `status`/`headers` (`ResponseWire` — the web-standard `ResponseInit` fields as data) ride beside the mode; platform adapters map everything (`new Response(body, init)` on v2, `{ statusCode, headers, body }` on classic/Lambda). `after` is skipped on a framework error (the 500 retry contract) and never clobbers a pre-dispatch client rejection (webhook `rejectUnverified`). `{ fromResults }` is rejected under a background/202 platform — "202 first, then work" is a PLATFORM choice (`netlifyBackgroundPlatform`), not an `after` mode. The earlier per-module `resolve`/`respond`/`response` fields are all removed (registering them throws with the migration pointer); an action/webhook's work runs as JOBS and the reply is composed from their outputs. `KitEventDescription.response`/`FlowResponseKind` are removed from describe()/flow output (events no longer have response kinds); the `expectFlow(...).respondsWith(...)` testing assertion is removed with them. New core types `HandlerResponse`/`ResponseBody`/`ResponseWire`.
  - **`registerEvent`/`registerEvents` now accept `EventModule<any, any, any>`** (type-level widening): a source-typed module registers without a variance cast under strict compiler flags (e.g. `exactOptionalPropertyTypes`). Runtime unchanged.
  - `docs/guide.html`: documented `kit.dryRun()` and the Hasura sources' factory/config form (inbound token discovery) in the API reference; replaced the webhook walkthrough with a real Stripe `payment_intent.succeeded` example (now authored with `webhook.defineEvent<StripePaymentEvent>` and the reply declared at `kit.handler({ after: { body } })`) and the `hmacVerify` preset (the previous example called `.detector` on the bare factory — which didn't exist before this change — and showed retry semantics that don't match Stripe's redeliver-on-any-non-2xx contract).

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
