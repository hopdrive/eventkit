# EventKit Architecture RFC — v0.3.15 (Canonical)

> **Status of this document.** This is the **canonical** EventKit architecture spec and the source of truth (revision **v0.3.15** — see the revision-history table below). It grew from an RFC: it folded the original v0.1 design, Amendments A–E, and the pre-build design evaluation; those source docs have since been removed (their rationale is distilled in `design-rationale.md`, and the decisions live in the ADRs in §22). Materially changed sections are marked **[v0.2]** / **[v0.3.x]** inline.

Status: Canonical (accepted)
Owner: HopDrive Engineering
Document Purpose: Canonical architecture specification for EventKit. Records agreed decisions, rationale, examples, implementation guidance, and future considerations. Updated whenever meaningful architecture decisions are made.

## Revision History

| Date | Version | Author | Summary |
|---|---:|---|---|
| 2026-06-25 | 0.1 | ChatGPT + HopDrive | Created living RFC shell from consolidated EventKit design. |
| 2026-06-28 | 0.2 (draft) | HopDrive Engineering + Claude | Folded Amendments A–E and recovered lost concepts. Pinned the four production-critical seams (job data channel, source handler context, per-invocation entry, durable execution) and `run()` defaults. Added ADR-011…016. |
| 2026-06-28 | 0.3 (draft) | Rob Newton + Claude | Applied design-change record CHG-1…6: plugins self-correlate via lifecycle (jobs stay plugin-agnostic; `durable` is a boolean, no `ctx.batch.record`); handlers are strict declarative job lists (conditional job inclusion is a compile/runtime error); register-style API (`kit.use()` / `kit.registerEvents()`, single `source: hasuraEvent`); resolved D14. Added ADR-017…019, principles §3.9–3.10. |
| 2026-06-28 | 0.3.1 (draft) | Rob Newton + Claude | CHG-7: removed the core `durable` flag — durability is emergent from registering the Batch plugin (registered only in `db-batchjobs`, `requires` Hasura source). Added generic `augmentJobContext` plugin context-contribution + input-merge (ADR-020); Batch auto-injects the row's `input`, auto-persists, and offers configurable periodic log flushing (§12.6). Revised ADR-015. |
| 2026-06-28 | 0.3.2 (draft) | Rob Newton + Claude | CHG-8: added the `PlatformAdapter` contract (§9.8) registered via `createEventKit({ platform })`; ships `lambdaPlatform()` + `netlifyPlatform()` with planned `netlifyV2Platform()`/`netlifyBackgroundPlatform()`; time budget collapses to three adapter strategies (native countdown / computed deadline / none); `kit.handler()` entry style; detect-and-warn. Added ADR-021. |
| 2026-06-28 | 0.3.3 (draft) | Rob Newton + Claude | CHG-9: plugin **composition model** (§11.1–11.3) — three hook shapes (notification / delta transform / singleton capability); default always runs, "default + extra" is native, replacement is DI-injected `base` not inheritance; `provides`/`requires` capability declaration; naming rule (`on…` void vs bare-verb returns-value) → renamed `onPreConfigure`/`onConfigureInvocation`→`configureInvocation`, `initialize/flush/shutdown`→`onInit/onFlush/onShutdown`; added `augmentEnvelope`; before→after table for the prebuilt plugins (tracking-token & order-enrichment stop mutating the payload). Added ADR-022. |
| 2026-06-28 | 0.3.4 (draft) | Rob Newton + Claude | CHG-10: registration convention → `kit.use(plugin, config?)` (pass the plugin/factory, not a call; kit instantiates) — §11.4; platform moves from a `createEventKit` param to `kit.use(netlifyPlatform)` (required source stays the param); platform factories renamed `*Platform` (`netlifyPlatform()`, `lambdaPlatform()`, …). Revised ADR-019. |
| 2026-06-28 | 0.3.5 (draft) | Rob Newton + Claude | CHG-11: dropped the `createEventKit({ source })` object wrapper — the source is now the first positional arg, same `(plugin, config?)` shape as `use()`: `createEventKit(hasura)` / `createEventKit(webhook, { verify })`. Revised ADR-019. |
| 2026-06-28 | 0.3.6 (draft) | Rob Newton + Claude | CHG-12: two Hasura source adapters named by transport — **`hasuraEvent`** (DB triggers) and **`hasuraCron`** (Hasura scheduled triggers, a sibling payload), replacing "hasura + generic cron." `createEventKit(hasura)` → `createEventKit(hasuraEvent)`; authoring helpers `hasuraEvent.detector/.handler` + `hasuraCron.detector/.handler`. Added ADR-023. |
| 2026-06-28 | 0.3.7 (draft) | Rob Newton + Claude | CHG-13: detector preferred style restored to the **`switch (ctx.operation)`** house style (named booleans inside each case; per-case sentence return; `case 'MANUAL': return false`), replacing the flat `insertedReady \|\| becameReady` form. Aligns §3.2/§8 examples with existing team guidance. |
| 2026-06-28 | 0.3.8 (draft) | Rob Newton + Claude | CHG-14: **generic-by-config plugins ship built-in** (subpath exports of `@hopdrive/eventkit`), not in a separate HopDrive package. loop-guard/tracking-token (a pure `source\|correlationId\|jobId` codec + a configurable read/write field + a service identity), grafana, and sentry are all fully config-driven, so they become parameterized built-ins. The HopDrive layer collapses to config presets + any genuinely SDK-coupled plugin + the app's event modules (which already live in the consumer repos). Reverses the earlier trackingToken/grafana/sentry → `@hopdrive/app-eventkit` plan. Added ADR-024. |
| 2026-06-29 | 0.3.9 (draft) | Rob Newton + Claude | CHG-15: **event modules are fully declarative** — the handler-that-calls-`run()` is replaced by a static `jobs` array the **runtime** executes. Module shape `defineEvent({ name, detector, prepare?, jobs, run? })`; detector keeps the `switch` house style; `prepare(ctx)` produces shared request-scoped refs (sdk/clients/closures) merged into every job's `input`. Three hard rules: no conditional job inclusion (impossible by construction — no handler body), **no fan-out** (do it in the job or via DB writes), **no inter-job dependencies** (siblings are mutually ignorant). `run()` becomes runtime-internal; `RunOptions` move onto the module. Migration playbook for the ≈14 conditional sites (promote-to-event vs job-internal short-circuit). Added ADR-025; supersedes the ADR-018 "handler returns JobDefinition[]" framing. |
| 2026-06-29 | 0.3.10 (draft) | Rob Newton + Claude | CHG-16: **full `event-handlers` source coverage.** Goal = migrate every function class, not just `db-*`. Added the source-inventory table (§7), the **`webhook`** source (§7.1), and the **`hasuraAction`** source (§7.2) with Hasura's exact request payload + response contract. Introduced the **request/response source class** (actions + `app-*` RPC return a synchronous payload, unlike fire-and-forget events) and proposed `resolve(ctx)=>output` + a `hasuraActionPlatform` mapping outcome→2xx / `ClientError`→4xx `{message,extensions}`. Added `'action'` to `EventSourceType`. Added ADR-026. |
| 2026-06-29 | 0.3.11 (draft) | Rob Newton + Claude | **Implemented** `webhook` + `hasuraAction` sources + the `resolve` request/response capability (ADR-026). **Dropped `hasuraActionPlatform`** — the response contract (`resolve`→2xx, `ClientError`/`ActionError`→status+`{message,extensions}`) composes onto the **generic** platforms (`netlifyPlatform`/`netlifyV2Platform`/`lambdaPlatform`) via `InvocationResult.resolved`, avoiding a `contract × transport` matrix. Flipped §7.1/§7.2 to shipped. |
| 2026-06-29 | 0.3.12 (draft) | Rob Newton + Claude | CHG-17: **`app-*` → Hasura Action conversion playbook** (§19.2). Per-endpoint, gradual: define the Action (input/output types + handler) via a `hasura-migrations` PR; port the handler into a `hasuraAction` module (`resolve` returns the output, `prepare`/`jobs` for setup/side-effects); **replace hand-rolled auth with Action RBAC permissions**; **verify every caller has the granted role and switch it from HTTP → the GraphQL action**; shadow + retire. Queries before mutations; convert one end-to-end first. |
| 2026-06-29 | 0.3.13 (draft) | Rob Newton + Claude | **Removed the operation-predicate detector helpers** (`inserted()`/`updated()`/`deleted()`/`manuallyInvoked()`) from `HasuraDetectorContext`. The preferred `switch (ctx.operation)` style makes them redundant (`case 'MANUAL': return false` handles console-edit suppression). The column/value helpers (`columnChanged`/`columnAdded`/`columnRemoved`/`previousValue`/`currentValue`) stay, since they're used inside the switch cases. Updated §3.6/§7/§8 + the guide/README. |
| 2026-06-30 | 0.3.14 (draft) | Rob Newton + Claude | **One unified plugin model + code organization (ADR-027, §11.0).** Sources and platforms are documented as *narrowly-scoped plugins* — kinds of one `plugin` concept distinguished by the capability they `provide` (`'source'` / `'platform'`), each declaring `name`/`provides`/`requires`. The three interfaces (`SourceAdapter`/`PlatformAdapter`/`EventKitPlugin`) are kept (not collapsed); registration is unchanged (positional source preserved). Code reorganizes into a **flat** `src/plugins/` — every plugin its own folder (no subcategories), **type-first dash-case names with the folder === plugin `name` exactly**: `source-hasura-event`/`-cron`/`-action` (each its own plugin; shared bits in `hasura-shared/`), `source-webhook`, `platform-lambda`/`-netlify`/`-netlify-v2`/`-netlify-background`, and the unprefixed `observability`/`batch`/`loop-guard`/`grafana`/`sentry`. The recorded source (`envelope.source`/`source_system`) is taken from the normalized envelope, not the plugin `name`. Public subpaths stay short and unchanged via the `exports` map. Updated §7, §9.8, §11, §17. |
| 2026-06-30 | 0.3.15 (draft) | Rob Newton + Claude | **Family-barrel exports (import DX).** Added aggregate subpaths `./sources` (all source plugins) and `./plugins` (all observer/transform plugins) alongside the existing `./platforms`, and declared `"sideEffects": false` so esbuild/Netlify tree-shake the barrels. A consumer now writes ~4 eventkit import lines instead of ~8; granular subpaths stay for the tightest bundle. `graphqlSink` is also re-exported from `./plugins/observability`. Updated §17 + ADR-024. |
| 2026-06-30 | 0.3.16 (draft) | Rob Newton + Claude | **Result-driven response seam `respond` (ADR-029, amends ADR-026).** A request/response module may declare `respond(ctx, { jobs, ok }) => output` instead of `resolve` when the synchronous reply must reflect the **outcome** of the work: the runtime runs `jobs` under the module's `run` config, waits for them to settle, then calls `respond` with the settled `JobExecution[]` + an `ok` flag. Same wire mapping as `resolve` (return → 2xx, thrown `ClientError`/`ActionError` → status). **Mutually exclusive with `resolve`**, requires ≥1 job, and rejected at `validate()` under a `deferredResponse` platform (background/202). `resolve` stays the concurrent, sibling-ignorant fast-ack. New `RespondFunction`/`JobsResult`; `PlatformAdapter.deferredResponse`. Updated §3.x, §7. |
| 2026-07-01 | 0.3.18 (draft) | Rob Newton + Claude | **Series job execution deferred — parallel-only initial release (ADR-031, amends ADR-014).** The configurable `run.mode` (`'series'`) switch and `continueOnFailure` (module- and per-job) are **specified but not enabled**: the public `RunOptions`/`JobOptions` omit them and the runtime runs every module's jobs in **parallel with isolated failures**. Held back because series invites sequential inter-job coupling (reintroducing the control flow ADR-025 removed) with more abuse risk than value at launch; kept as a documented possible future feature behind the same `run.mode` API. Updated §9.5, §9.4, ADR-014, the §0 summary, and the `'skipped'` status note. |
| 2026-06-30 | 0.3.17 (draft) | Rob Newton + Claude | **Webhook `rejectUnverified` — one-chokepoint signature rejection (ADR-030).** `webhook({ vendor, verify, rejectUnverified })`: a failed/throwing `verify` is rejected with **401** (configurable via `{ status, message }`) **before** detection, so no detector needs a `signatureVerified` guard. Mechanism: the adapter throws `ClientError` from `normalize`; the runtime now maps a **pre-dispatch `ClientError`** (duck-typed `.status`) to that wire status via `resolved.error` instead of the framework 500, skipping dispatch. Requires `verify`. Trade-off: a rejected request leaves no Invocation record (a framework `warn` only) — keep the default and guard in the detector when the forged attempt must be recorded. Updated §7.1. |
| 2026-07-01 | 0.3.19 (draft) | Rob Newton + Claude | **Flow-doc generator SHIPPED (ADR-032) — the "generator verifies structure" half of §14–§16.** `kit.describe()` returns a pure, read-only structural snapshot of a built kit (source, platform, plugins, every event + its static job set); the new **`@hopdrive/eventkit/flow`** subpath adds `toFlowYaml(kit)` (a committed, diff-friendly YAML doc of how events flow through the system), `toFlowGraph(kit)` (`{ nodes, edges }` in the `FlowNode`/`FlowEdge` manifest vocabulary — retires the §16 doc-drift where `FlowManifest` was listed as exported but wasn't), and `describeKit(kit)`. Ships the **`eventkit-flow` CLI** (`generate` / `check`) for consumer npm scripts + CI drift-gating; zero new runtime deps (built-in YAML emitter). Faithful precisely because modules are declarative (ADR-025). Flow **Manifests** (hand-authored meaning) and **Compare Mode** + the Console remain phased — see `console-expected-flows.md`. Updated §14, §15, §16, §17, the `EventKit` contract, and D9. |

---

# 0. What changed in v0.2 (read this first)

v0.1 was conceptually strong but left the *seams to the existing system* underspecified — and every one of those seams is load-bearing across the 245 event modules and ~40 jobs in `event-handlers`. v0.2 closes them with concrete, type-checked contracts:

- **[A] Job data channel** (§9, §10). `job(fn, options)` now has two separately-typed channels: `input` (request-scoped, live, **never** persisted) and `metadata` (serializable, persisted/recorded). This is the migration target for today's overloaded options bag (live `sdk` clients, closures, `old`/`new` rows).
- **[B] Source handler context** (§7, §9). Source adapters contribute a typed handler-context extension. `HasuraHandlerContext` exposes `operation`/`oldRow`/`newRow` + session-derived `role`/`userId`/`receivedAt` — **data only, no detection helpers** — so ADR-007's intent survives without stripping the data handlers legitimately need.
- **[C] Per-invocation entry point** (§6, §9, §11). `createEventKit()` runs once at module scope and returns an `EventKit` with `handle(payload, request)`. Defines the previously-undefined `InvocationContext`, plus `RequestContext` for per-request config — replacing per-invocation plugin registration and the old `onPreConfigure` mutation hook. Specifies the **tracking-token loop-guard mechanism** and preserves MANUAL suppression via the `switch (ctx.operation)` house style (`case 'MANUAL': return false`). *(An interim plan to restore a `manuallyInvoked()` helper was reversed in v0.3.13 — the operation-predicate helpers were removed; see §7/§8.)*
- **[D] Parallel, isolated job execution** (§9, §10). Every module runs its jobs in parallel with isolated failures, matching the current `Promise.allSettled` fan-out. **[v0.3.18, ADR-031] The configurable `mode: 'series'` switch (+ `continueOnFailure`) is deferred — not enabled in the initial release;** it stays specified as a possible future control (§9.5).
- **[E] Durable contract** (§9, §12). Batch becomes a durability plugin with the `BatchJobStatus` enum and a lifecycle-hook→status mapping; job code stops calling `batchJob(...)`. *(The v0.2 form — `DurableJobOptions`, `batch.record(...)`, `ctx.batch.record` — was **superseded in v0.3.1**: durability is now emergent from registering the plugin, with no `durable` flag and no batch object on `ctx`. See the v0.3 refinements below and §12.)*
- **Recovered concepts**: `SerializedError` + core serialization utilities (§9, §12), tiered logger interfaces (§9), `JobProgress`/`JobCheckpoint` shapes (§9), `EventModule.metadata` (§18), normative buffer-and-flush for Observability (§13), subpath-export bundling validation (§17), event-name backward-compatibility policy (§8), and a Compare-Mode phasing caveat (§14).

If you only review one thing, review §9 (Runtime API) and §12 (Batch) — that is where the migration succeeds or fails.

**v0.3 refinements (see `design-change-log.md`):**
- **Plugins self-correlate; jobs stay plugin-agnostic** (§3.10, §12, ADR-017). **[v0.3.1]** Durability is **emergent from registering the Batch plugin** — there is no core `durable` flag. The plugin (registered only in `db-batchjobs`, `requires` the Hasura source) makes every job durable, injects the `batch_jobs` row's `input` as the job's baseline `ctx.input` (handler input merges on top), persists state/output/logs, and offers configurable periodic log flushing for the live React view. Plugins supply job data via `augmentJobContext` (ADR-020); no `ctx.batch.record`, no record-passing.
- **Handlers are strict declarative job lists** (§3.9, §9.5, ADR-018). Conditional job inclusion (`cond && job(...)`) is a compile/runtime error. Conditions live in the detector (a named event) or inside the job (input-driven). This reverses v0.2's "tolerate falsy entries."
- **Register-style API** (§9.7, §11.4, §18, ADR-019). `createEventKit(hasuraEvent)` — the required source is the first positional arg, same `(plugin, config?)` shape as `use()` (no object wrapper; `createEventKit(webhook, { verify })` when the source needs config). Then `kit.use(plugin, config?)` — pass the plugin/factory itself, not a call; the kit instantiates it. The optional platform registers the same way: `kit.use(netlifyPlatform)`. Events via `kit.registerEvents(events)`. One source per kit (resolves D14).
- **[v0.3.2] Platform adapters** (§9.8, ADR-021). Runtime specifics (invocation signature, payload, time budget, response) sit behind a `PlatformAdapter` registered via `kit.use(netlifyPlatform)`. Ships `lambdaPlatform()` + `netlifyPlatform()`; the time budget collapses to three strategies (native countdown / computed deadline / none); handlers become `kit.handler()`. Netlify's classic/v2/background flavors get separate adapters. Keeps EventKit runtime-independent rather than Netlify-locked.
- **[v0.3.3] Plugin composition model** (§11.1–11.3, ADR-022). Every hook is one of three shapes — **notification** (`onX`, void; spans `Start/End`, capability brackets `Before/After`, self-lifecycle `onInit/onFlush/onShutdown`), **delta transform** (bare verb returning a partial the runtime merges: `configureInvocation`, `augmentEnvelope`, `augmentJobContext`), **singleton capability** (bare verb, one provider via `provides`). The built-in default always runs; "default + a little extra" is native via notifications/transforms; replacement (shape 3 only) reuses the default by DI-injected `base`, never inheritance. Naming: `on…` = void notification, bare verb = returns a value. This stops tracking-token/order-enrichment from mutating the payload.
- **[v0.3.6] Hasura source adapters named by transport** (§7, ADR-023). Two Hasura-origin adapters: **`hasuraEvent`** (DB event triggers) and **`hasuraCron`** (Hasura scheduled triggers — a sibling payload `{ name, scheduled_time, payload }`, not a generic cron). `createEventKit(hasura)` → `createEventKit(hasuraEvent)`; `createEventKit(hasuraCron)` for scheduled functions. Authoring: `hasuraEvent.detector/.handler` (rows/operation) and `hasuraCron.detector/.handler` (`scheduleName`/`scheduledAt`/`payload`).

---

# 1. Why EventKit Exists

EventKit is one of the foundational abstractions HopDrive intends to build on for the next decade. It standardizes how business events are discovered, executed, observed, documented, and reasoned about by both humans and AI agents.

Its purpose is not simply to replace the Hasura Event Detector. That migration is the immediate forcing function, not the strategic endpoint. EventKit establishes a stable architectural language that can survive changes to infrastructure, event sources, deployment environments, execution models, and developer tooling.

The existing Hasura Event Detector proved that HopDrive benefits from naming business events explicitly and authoring detection logic in readable event modules. EventKit preserves that strength while removing the assumption that Hasura is the center of the event architecture. In the long term, HopDrive business behavior should be expressed in terms of business events, handlers, jobs, flows, and observations rather than whichever infrastructure component delivered the original signal.

EventKit exists to answer three questions consistently:

1. What came into the system?
2. What business event did it represent?
3. What work ran because of that business event?

Those map directly to the runtime vocabulary: **EventEnvelope** answers what came in; **DetectedEvent** answers what business event was detected; **JobExecution** answers what work ran. The framework MUST preserve clean separation between source mechanics, business detection, execution, durability, and observability.

The most important developer experience is the **event module**. A developer opening one should immediately see the business detection logic: the detector MUST appear at or near the top, and SHOULD read like a set of named business facts followed by a final boolean. A business event name represents the domain event, not the transport — `move.pickup.started` is a business fact, independent of whether Hasura, a webhook, or a cron discovered it.

# 2. Goals and Non-Goals

## 2.1 Primary Goals
- EventKit MUST generalize the Hasura Event Detector into a source-agnostic execution framework, supporting Hasura without making Hasura the central abstraction.
- EventKit MUST preserve the event-module authoring model: business-event dot-notation names; each module declares exactly one detector and a static `jobs` set (and/or a `resolve`/`respond` for request/response). There is no handler body — the module is declarative (ADR-025).
- EventKit MUST optimize detector readability (named boolean variables; final return reads like a sentence).
- EventKit MUST support source adapters (Hasura, webhook, cron, application, queue, manual, and future).
- EventKit MUST stay domain-agnostic. Core, source adapters, and generic plugins MUST NOT contain HopDrive business rules. Move/driver/dealer/AR helpers live in application packages.
- EventKit MUST make Batch a first-class **durability plugin** (persistence, retry history, delayed execution, state transitions).
- EventKit MUST make Observability a first-class plugin (invocation/event/job records, logs, progress, checkpoints, errors, timings, correlation, chained invocations).
- **[v0.2]** EventKit MUST provide a typed, request-scoped **job input channel** distinct from persisted job metadata (§9/§10, ADR-011).
- **[v0.2]** EventKit MUST define a single per-invocation entry point and the per-request context it threads to plugins (§9/§11, ADR-013).
- EventKit SHOULD support Flow Manifests, Compare Mode, and a Console (§14–§16), phased behind the runtime migration.

## 2.2 Secondary Goals
- Improve AI-assisted development via a stable, machine-readable architecture surface.
- Support incremental migration; existing modules move with minimal, mechanical changes where possible.
- Let applications register only the sources and plugins they need.
- Support testing at multiple levels (detector, adapter, handler/job, plugin, flow, e2e).

## 2.3 Non-Goals
EventKit is not a workflow engine, BPMN engine, distributed-transaction coordinator, or ORM, and is not the owner of HopDrive business logic. Flow comparison MUST NOT gate production execution.

# 3. Design Principles

## 3.1 Business Events Are the Primary Abstraction
Event modules are the center of the developer experience. Event names describe what the system believes happened; source adapters describe how data entered.

## 3.2 Detectors Must Be Readable
Readability is a first-order requirement. **[v0.3.7]** The preferred Hasura detector style is the one the existing `hasura-event-detector` modules already use and the team likes: a `switch` on `ctx.operation`, with named boolean facts declared **inside each case branch**, and each case's `return` reading like a sentence. (This is the house style recorded in team guidance; the earlier flat named-boolean form is not preferred for Hasura.) Preferred:

```ts
export const detector = hasuraEvent.detector<MoveRow>((ctx) => {
  const { operation, newRow, oldRow } = ctx;   // destructure data; helpers stay on ctx
  switch (operation) {
    case 'UPDATE': {
      const pickupStartedChanged = ctx.columnChanged('pickup_started');
      const pickupStartedWasSet  = newRow?.pickup_started !== null;
      const timestampIsValid     = isStatusTimeChangeValid(newRow?.pickup_started, oldRow?.pickup_started);
      return pickupStartedChanged && pickupStartedWasSet && timestampIsValid;
    }
    case 'INSERT':
    case 'DELETE':
    case 'MANUAL':   // suppress Hasura console edits
    default:
      return false;
  }
});
```

Each case's variables are defined in its own branch (even if a name repeats across cases) — don't hoist shared booleans above the `switch`. Discouraged: collapsing the operations into combined booleans (`const becameReady = ctx.updated() && … ; return insertedReady || becameReady`) or a single inline `&&` chain — both read worse than the per-operation switch. The framework MUST NOT introduce a fluent detector DSL that hides intent (explicitly rejected in planning).

## 3.3 Frameworks Must Stay Generic
Core knows invocations, envelopes, detectors, handlers, jobs, plugins, lifecycle. The Hasura adapter knows operations, tables, old/new rows, column changes — **not** move status rules. Application packages own domain semantics. Domain helpers (e.g. `isMoveOperationallyDone`) MUST NOT live in a source adapter.

## 3.4 Explicit Registration Is Required
Event modules MUST be explicitly registered (§18). This favors determinism over magic and is required for reliable serverless bundling. Filesystem auto-discovery is deferred; if introduced later it MUST generate explicit registration artifacts at build time, never rely on runtime dynamic imports.

## 3.5 One Detector Per Event Module
Each module MUST declare exactly one detector. The work it triggers is a **static `jobs` array** (and/or a `resolve`/`respond` for request/response) — there is no handler function (ADR-025).

## 3.6 Plugins Extend Infrastructure, Not Business Logic
Plugins provide observability, durability, tracing, metrics, audit, error capture. They MUST NOT hide business detection. **[v0.2]** Plugins MUST NOT use mutation of arbitrary shared objects as their integration model (ADR-012); they augment context through typed extension contracts (§7, §11).

## 3.7 Expected Flow and Observed Flow Are Separate Truths
Expected Flow is the contract; Observed Flow is the evidence; Compare Mode reconciles them without replacing either.

## 3.8 [v0.2] Persisted and Live Data Are Separate Channels
Any value that crosses a durability or observability boundary MUST be serializable and MUST travel in a designated *persisted* channel (`metadata`, `batch_jobs.input/output`). Live, request-scoped values (clients, closures, source rows) MUST travel in the designated *non-persisted* channel (`input`). Conflating the two is the root cause of the current options-bag incompatibility with durability (ADR-011).

## 3.9 Handlers Are Declarative Job Lists

A handler declares the set of jobs that run when its event is detected. It MUST NOT conditionally include or exclude a job (`cond && job(...)`, ternaries, conditional `push`). Conditional behavior has exactly two legitimate homes: the **detector** (if whether work runs is a business condition, it defines a distinct business event — give it a name), or **inside the job** (input-driven branching that applies to every invocation). A conditional job in the handler is a hidden branch the observability and flow tooling cannot see; it cannot be rendered in the runtime visualizations or documented in a Flow Manifest, which defeats two core goals of EventKit. The runtime enforces this (§9.5): `jobs` is a strict `JobDefinition[]`, and a non-job entry is a compile error and a runtime throw (ADR-018).

**[v0.3.9] The module is fully declarative; the runtime runs the jobs (ADR-025).** The strongest form of the rule above is to remove the handler body entirely: an event module is `defineEvent({ name, detector, prepare?, jobs, run? })`, where `jobs` is a **static array literal** of `job(fn, { input? })` and the runtime — not consumer code — executes them. With no handler body there is nowhere to branch, so conditional job inclusion is impossible *by construction* (the type brand becomes a backstop, not the primary defense). `prepare(ctx) => shared` produces request-scoped shared references (an initialized `sdk`, fetched rows, helper closures) that the runtime merges into every job's `ctx.input`; this is data preparation, never job selection. Two further invariants keep the chain deterministic: **no fan-out** (data-driven multiplicity lives inside a job or in DB writes that trigger further events, never as N emitted jobs) and **no inter-job dependencies** (sibling jobs are mutually ignorant of each other's existence, result, order, and input). A job is a context-free, reusable unit that behaves identically regardless of which siblings exist.

## 3.10 Plugins Self-Correlate; Jobs Stay Plugin-Agnostic

A plugin does its work **through the lifecycle interface alone**, correlating any runtime state it needs from the context it already receives (invocation id, the triggering envelope, job execution id). Jobs and handlers MUST NOT thread plugin-specific objects (a batch record, a token instance) through `input`/`options` to make a plugin function. A job MAY read ambient runtime values the framework populates on its context (`ctx.log`, `ctx.signal`, `ctx.trackingToken`), and MAY receive ordinary business data via `input` — but it MUST behave identically regardless of which plugins are loaded. This keeps jobs independent and reusable, and it is how the Observability and Batch plugins both operate: pure observers of lifecycle that attribute state from IDs, not from job cooperation (ADR-017).

# 4. Terminology

- **Invocation** — a single inbound execution initiated by a source adapter; has one EventEnvelope and may produce zero, one, or many detected events. Represented at runtime by `InvocationContext`. **[v0.2]**
- **EventEnvelope** — normalized representation of what came in: source identity/type, received time, correlation ID, payload, meta, optional raw. Source-agnostic; MUST NOT expose source helpers like `columnChanged()`.
- **DetectorContext** — context passed to a detector; common runtime fields plus a source-specific helper API. Detection-only.
- **DetectedEvent** — created when a detector returns true; a normalized business event. Does NOT carry DetectorContext (ADR-007).
- **HandlerContext** — passed to the handler after detection. Generic base; MAY be extended by the source with **data** (not detection helpers). **[v0.2]**
- **Job** — a unit of work executed because of a detected event.
- **JobExecution** — the result record of a job attempt.
- **Plugin** — a lifecycle extension.
- **RequestContext / InvocationContext** — **[v0.2]** the per-request input to `handle()` and the per-invocation context threaded to plugins (§9, §11).
- **Flow Manifest** — a source-controlled business-process contract.

# 5. Architecture Overview

Every inbound request enters through a Source Adapter, which constructs an EventEnvelope and a DetectorContext. The runtime evaluates every registered detector independently; positive detections produce DetectedEvents whose declared `jobs` the **runtime** executes (after the module's optional `prepare`), and whose optional `resolve` computes a response for request/response sources (ADR-025/026). Plugins surround the runtime without owning it.

The runtime guarantees deterministic ordering: normalization → detection → prepare → jobs (+ resolve, or respond after jobs settle), with consistent plugin callback ordering. Errors are isolated: a detector failure affects only that detector; a job failure is isolated from other jobs by default (§10, ADR-014).

# 6. Runtime Lifecycle

Every invocation follows the same lifecycle regardless of source.

1. **Receive** — the source adapter receives a source-specific payload.
2. **Normalize** — the adapter validates and normalizes into an EventEnvelope and constructs the DetectorContext. **[v0.2]** The Hasura adapter (or a tracking-token plugin at `configureInvocation`/`onInvocationStart`) extracts inbound provenance from `updated_by` into `envelope.meta.sourceTrackingToken` (§13 loop prevention).
3. **Invoke plugins** — `onInvocationStart(ctx: InvocationContext)`.
4. **Evaluate detectors** — each registered detector runs independently; returns boolean. Detector duration is recorded.
5. **Prepare** — **[v0.3.9]** for each detected event, the module's optional `prepare(ctx)` runs once, producing request-scoped shared refs the runtime merges into every job's `ctx.input`.
6. **Execute jobs** — the runtime runs the module's declared `jobs` (no handler body — ADR-025); it records timing, retries, failures, cancellation, checkpoints, progress, outputs.
7. **Resolve (request/response only)** — **[v0.3.11]** if the module declares `resolve(ctx)`, the runtime computes the response body and surfaces it on `InvocationResult.resolved`; a thrown `ClientError`/`ActionError` is captured there too. Jobs run alongside and are never read by `resolve` (ADR-026).
8. **Finalize** — completion callbacks fire; observability flushes; durability state is updated. **[v0.2]** `handle()` returns an `InvocationResult`; the platform adapter maps `resolved` to the wire response.

**[v0.2] Entry point.** A serverless function processes one payload by calling `kit.handle(rawPayload, request)` on a module-scoped `EventKit` (§9). This replaces `listenTo()` and the per-invocation plugin registration pattern.

# 7. Source Adapter Contract

**A source adapter is a plugin** — the kind that provides the required singleton `'source'` capability (§11.0). It declares `name`/`provides: ['source']`/`requires` like any plugin and lives in its own flat folder under `src/plugins/source-<name>` (e.g. `src/plugins/source-hasura-event`, `src/plugins/source-webhook`), the folder name equal to its `name`; `SourceAdapter` below is just the capability-specific interface for this kind. Every source adapter identifies inbound work, normalizes payloads, creates an EventEnvelope, and constructs a DetectorContext. Adapters own translation, never business interpretation.

Adapters MAY expose convenience helpers that improve detector readability, expressing *source* semantics (`columnChanged()`, `columnAdded()`, `columnRemoved()`, `previousValue()`, `currentValue()`), never application semantics. **[v0.3.13]** Operation-predicate helpers (`inserted()`/`updated()`/`deleted()`/`manuallyInvoked()`) were removed in favor of switching on `operation`.

**[v0.2] Source handler-context extension (Amendment B).** A source adapter MAY contribute a typed handler-context extension carrying source **data** (never detection helpers). The adapter that normalized the envelope owns this enrichment because it already parsed the source payload.

```ts
export interface SourceAdapter<TPayload = unknown, TDetectorCtx = unknown, THandlerExt = {}> {
  name: EventSourceName;
  sourceType: EventSourceType;
  provides: Capability[];           // ['source'] — the singleton capability this plugin fills (§11.0)
  requires?: Capability[];          // capabilities this source depends on, if any
  normalize(raw: unknown, request: RequestContext): EventEnvelope<TPayload>;
  buildDetectorContext(envelope: EventEnvelope<TPayload>, base: DetectorContext<TPayload>): TDetectorCtx;
  buildHandlerContext?(envelope: EventEnvelope<TPayload>, base: HandlerContext<TPayload>): THandlerExt; // [v0.2]
}
```

`EventSourceType` includes `'database' | 'webhook' | 'cron' | 'action' | 'application' | 'queue' | 'manual'`. **[v0.2]** `'manual'` and `'queue'` are first-class per planning; **[v0.3.10]** `'action'` added for Hasura Actions (§7.2, ADR-026).

**[v0.3.10] Source coverage for the full `event-handlers` migration.** The goal is to migrate *every* function class in `event-handlers` onto EventKit — not only the `db-*` functions that use the legacy package today. The actual inventory and its source adapters:

| `event-handlers` function class | count | Source adapter | sourceType | Status |
|---|---|---|---|---|
| `db-*` (Hasura DB event triggers) | ~31 | `hasuraEvent` | `database` | shipped |
| `cron-*` (Hasura scheduled triggers) | ~22 | `hasuraCron` | `cron` | shipped |
| `webhook-*` (Stripe, Twilio×3, Dealerware) | 5 | `webhook` | `webhook` | **shipped** |
| `app-*` / `build-*` / `get-*` / `save-*` (app-facing request/response) | ~20 | **not migrated** — bespoke today; *replaced over time* by `hasuraAction` | — | deprecate → replace |
| `one-off-*` (HTTP-POST one-shot commands) | 2 | `webhook` or `manual` | `webhook`/`manual` | **to build** |

**[v0.3.10] `app-*` are deprecated, not migrated.** The bespoke `app-*` endpoints don't use any event framework today and don't *need* EventKit — they stay as-is and are **gradually replaced by `hasuraAction` GraphQL calls**, for two reasons. (1) **Security.** Every `app-*` endpoint rolls its own auth and can do anything; scrutiny is uneven, so the surface of "custom endpoints that may or may not properly protect privileged data/behavior" only grows. A Hasura Action runs **behind Hasura's permission model** — you grant a role access to the action's GraphQL field, so privileged server-side behavior is gated by Hasura RBAC consistently, not by per-endpoint hand-rolled checks. (2) **Observability** (below).

**Request/response is a general EventKit capability, not action-only.** The reason `hasuraAction` should be an EventKit module — rather than a bespoke endpoint — is that an action can trigger **downstream effects** (jobs, and DB writes that fire further `hasuraEvent` invocations) that the Observability plugin can trace with a single **correlation id back to the originating action**. That same argument applies to **every entry point** — webhooks, crons, DB events: each is the *root* of a correlation-traced chain of downstream work (the correlation id propagates downstream via the tracking-token / loop-guard seam, §13, and the parent linkage via `source_job_id`). So `resolve` (the request/response seam — §7.2, ADR-026) is **source-agnostic**: any source's module may declare it, and that source's platform adapter maps the result to the wire response. Two *classes* still exist — **fire-and-forget** (detect → jobs; response is an ack: `hasuraEvent`, `hasuraCron`, ack-only `webhook`) and **request/response** (detect → `resolve` a payload + optional side-effect jobs: `hasuraAction`, and `webhook` vendors like Stripe that enforce a status contract) — but both are EventKit modules precisely so the whole downstream chain is visible from one trace.

**[v0.3.6] Two Hasura source adapters, not "hasura + a generic cron" (ADR-023).** HopDrive's scheduled jobs arrive as **Hasura scheduled (cron) triggers** — a Hasura payload (`{ name, scheduled_time, payload, id }`) that is a *sibling* of the DB-event payload (`{ event: { op, data }, table, trigger }`), not a generic cron. So the package ships **two** Hasura-origin source adapters, named for the transport they actually carry (echoing the current package's `hasuraEvent` export):

- **`hasuraEvent`** — Hasura **DB event triggers**; `sourceType: 'database'`. Detector context: `operation` (branch with a `switch`), `oldRow`, `newRow`, `row`, `columnChanged()`, `columnAdded()`, `columnRemoved()`, `previousValue()`, `currentValue()` (§8). This is the current detector's domain.
- **`hasuraCron`** — Hasura **scheduled triggers**; `sourceType: 'cron'`. Detector context: `scheduleName`, `scheduledAt`, `payload` (the configured trigger payload) — **no** rows/operation. A cron function's detector typically matches `ctx.scheduleName` or branches on `ctx.payload`.

Both `provides: ['source']`; a kit registers exactly one — `createEventKit(hasuraEvent)` for a `db-*` function, `createEventKit(hasuraCron)` for a scheduled function. The generic `'cron'` `sourceType` remains for a future non-Hasura scheduler, which would be a *different* adapter. Authoring helpers are `hasuraEvent.detector`/`hasuraEvent.prepare` and `hasuraCron.detector`/`hasuraCron.prepare`.

## 7.1 webhook source [v0.3.10; shipped v0.3.11]

Inbound vendor webhooks (`sourceType: 'webhook'`). Config: `webhook({ vendor, verify, eventTypeHeader, rejectUnverified? })`. The adapter verifies the signature *before* `normalize()` (surfacing `ctx.signatureVerified`) and reads the vendor's event-type header. Detector context: `signatureVerified`, `vendor`, `eventType`, `body`. Covers `event-handlers`' `webhook-*` (Stripe, Twilio, Dealerware) and the reverse-integration repos. Most are fire-and-forget; vendors with a **retry/status contract** (Stripe) return a status the adapter maps from the outcome — a thrown `ClientError(4xx, …)` → that status; otherwise 200/202. Pair with `netlifyV2Platform` for the v2/Web-`Request` functions.

**Signature verification placement (and `rejectUnverified`, ADR-030, v0.3.17).** `verify` runs **once** per request (in `normalize`, before any module) and by default **never throws** — it annotates `ctx.signatureVerified` and the detector decides whether to fire (§7.1; this keeps forged attempts observable and lets per-event policy differ). The detector's `signatureVerified && …` is therefore a cheap boolean *read*, not a re-verification. `handler({ before })` is **not** the place for signatures: it runs pre-`normalize` on the raw args and can't see `signatureVerified` without redoing the HMAC — reserve it for cheap request-level gates (method, auth-header presence). For an endpoint where *every* event requires a valid signature, set **`rejectUnverified: true`** (or `{ status?, message? }`): a failed/throwing `verify` is then rejected with **401** before detection (the adapter throws `ClientError`, the runtime maps a pre-dispatch `ClientError` → that wire status via `resolved.error`, skipping dispatch), so no detector guard is needed. Requires `verify`. Trade-off: a request rejected at `normalize` never becomes an event, so it produces **no Invocation/Event/Job record** (a framework `warn` only) — keep the default and guard in the detector when the forged attempt must be recorded for telemetry.

## 7.2 hasuraAction source — a request/response source [v0.3.10; shipped v0.3.11, ADR-026]

A **Hasura Action** is custom business logic exposed as a GraphQL query/mutation field: Hasura POSTs the action invocation to a handler and **returns the handler's response to the GraphQL client synchronously**. This is request/response, not fire-and-forget — the defining trait that separates it from the event sources above (ADR-026).

**Request payload Hasura sends** (verbatim from the Hasura docs):
```jsonc
{
  "action":  { "name": "<action-name>" },
  "input":   { "arg1": "…", "arg2": "…" },        // the action's arguments
  "session_variables": {                            // ALL keys lowercase
    "x-hasura-role": "<role>",
    "x-hasura-user-id": "<user-id>"
  },
  "request_query": "<the originating GraphQL query>"
}
```

**Response contract the handler MUST return:**
- **Success** — HTTP `2xx`, body = JSON matching the action's declared output type, e.g. `{ "accessToken": "…", "userId": 423 }` (object) or a scalar.
- **Error** — HTTP `4xx`, body = `{ "message": "<required>", "extensions": { "code": "<optional>", … } }`. Hasura surfaces `message` to the GraphQL client. (`code` at the root is accepted for back-compat; `extensions.code` is preferred.)

**`hasuraAction` source adapter** (`sourceType: 'action'`). `normalize()` wraps the payload into an envelope; detector/handler context exposes: `actionName`, `input` (typed args), `sessionVariables` (`role`/`userId`/`email`), and `requestQuery?`. A detector typically matches `ctx.actionName`. Authoring helpers `hasuraAction.detector`/`hasuraAction.prepare`/`hasuraAction.resolve`.

**How a declarative module returns a synchronous response (ADR-026 — ratified & implemented in v0.3.11).** EventKit modules are declarative *fire-and-forget* job sets (ADR-025); an action must return a value. The shape: a request/response module adds a single **`resolve(ctx) => output`** that computes the response body; `jobs` remain *optional* for fire-and-forget side effects that run alongside (notifications, logging). The **generic** platform adapter the function already uses (`netlifyV2Platform` / `netlifyPlatform` / `lambdaPlatform`) maps `resolve`'s return → the 2xx body, and a thrown `ClientError`/`ActionError(message, code?)` → the 4xx `{ message, extensions }` shape — there is **no** dedicated action platform (the response contract composes with transport; v0.3.11, below). Rationale: keeps the response logic explicit and separate from the (sibling-ignorant) jobs, instead of overloading a job's output as the response. `resolve` is **source-agnostic** — any source's module may declare it (a Stripe `webhook` resolving its required response, a future RPC source) — and the source's platform adapter maps the result to the wire. The win that makes an action worth running through EventKit at all: its downstream effects (jobs + DB writes that fire further events) are **correlation-traced back to the action** by the Observability plugin. The bespoke `app-*` endpoints are *replaced* by actions over time, not migrated. **Ratified (ADR-026): the `resolve` mapper, not a designated job output.**

**Result-driven response — `respond` (ADR-029, amends ADR-026, v0.3.16).** `resolve` is deliberately *sibling-ignorant*: it runs **concurrently** with the jobs and never reads their results, which is exactly right for a fast ack that depends only on the request. When the synchronous reply must instead reflect the **outcome** of the work (run N jobs, then answer based on their combined result) — without ejecting from `kit.handler()` to a hand-rolled `kit.handle()` — a module declares **`respond(ctx, { jobs, ok }) => output`** *in place of* `resolve`. The runtime runs the module's `jobs` under its `run` config, awaits them, then calls `respond` with the settled `JobExecution[]` and an `ok` flag (`every job completed|skipped` — the same predicate as `InvocationResult.ok`). The return becomes `InvocationResult.resolved.output` and a thrown `ClientError`/`ActionError` becomes `resolved.error` — **identical downstream plumbing to `resolve`**, so every platform maps it for free. The choice of *which seam a module declares* is the configuration (declarative, like ADR-025), so the response timing stays statically inspectable; `resolve` and `respond` are **mutually exclusive** (register-time error), `respond` **requires ≥1 job** (it reads results), and a `respond` module is **rejected at `validate()` under a `deferredResponse` platform** (background/202 — the response is already gone). Fire-and-forget stays the default (declare neither). Jobs keep their own retry/durability — `respond` only *reads* their executions to shape the reply. New core types `RespondFunction`/`JobsResult`; new `PlatformAdapter.deferredResponse` flag (set on `netlifyBackgroundPlatform`).

**Two failure types — `ClientError` vs `ActionError` (why both).** A `resolve` (or a job) reports failure by throwing one of two error classes, kept separate because the two callers react to fundamentally different things. `ClientError(status, message)` carries an **HTTP status**; the platform responds with that exact status — for a status-contract webhook (Stripe) the *status code* is the contract (it decides whether the vendor retries). `ActionError(message, code?, extensions?)` carries a **GraphQL error `code`**, *not* a status; the platform responds HTTP 4xx + `{ message, extensions: { code? } }`, which Hasura turns into a GraphQL `errors[]` entry — the GraphQL client reads `message`/`extensions.code` and never sees the HTTP status, so there is nothing meaningful to choose there. They are two different wire contracts (HTTP-status world vs. GraphQL-error world); folding them into one type would force a webhook author to invent a `code` and an action author to invent a `status` the client never sees. Both are read **duck-typed** by the runtime (not `instanceof` — unreliable across bundled module copies) and surfaced on `InvocationResult.resolved.error` for the generic platform to map.

# 8. Detector API and Event Module Authoring

The detector is the most important day-to-day API. It is a business-rule predicate answering one question: did this business event occur for this invocation? Every module MUST export exactly one detector, appearing at the top of the module (above its `jobs`/`resolve`).

The Hasura DetectorContext includes `operation`, `schema`, `table`, `oldRow`, `newRow`, `row` (= `newRow ?? oldRow ?? null`), `columnChanged()`, `columnAdded()`, `columnRemoved()`, `previousValue()`, `currentValue()`. **[v0.3.13]** The operation-predicate helpers (`inserted()`/`updated()`/`deleted()`/`manuallyInvoked()`) were **removed** — you branch on `operation` with a `switch`, which makes them redundant. Detectors MUST return `boolean | Promise<boolean>` and SHOULD avoid side effects.

**[v0.2] MANUAL handling (recovers a lost concept).** Hasura console edits arrive as `op: 'MANUAL'`. The switch style (§3.2) keeps the existing `case 'MANUAL': return false` branch verbatim. **[v0.3.13]** There is no `manuallyInvoked()` helper; the `switch` case is the way to suppress MANUAL. MANUAL suppression MUST stay expressible, because dropping it would silently begin firing events on console edits that are deliberately suppressed today.

Async detectors are permitted by the type but SHOULD be avoided: every detector runs for every invocation across all registered modules, so DB-touching detection is a scale and reliability risk. A future detection-phase timeout MAY be introduced; until then, detectors SHOULD be pure functions over the DetectorContext.

**[v0.2] Event name stability and backward compatibility.** Event names MUST be business-semantic, dot-notation, and **stable**. Renaming an event is a breaking architectural change: observability history, Flow Manifests, tests, and downstream consumers may key on it. Existing names already in production (including non-ideal ones) MUST be preserved during migration unless a deliberate, recorded rename with a backfill/aliasing plan is made. The migration MUST NOT "tidy" event names opportunistically.

# 9. Runtime API

The core runtime pipeline:

```
Raw source payload
  -> SourceAdapter.normalize()      // + provenance extraction [v0.2]
  -> EventEnvelope
  -> DetectorContext
  -> detector()
  -> DetectedEvent
  -> HandlerContext (+ source extension) [v0.2]
  -> handler()
  -> run()
  -> JobExecution[]
```

## 9.1 EventEnvelope, DetectedEvent

```ts
export interface EventEnvelope<TPayload = unknown, TMeta = Record<string, unknown>> {
  id: string;
  source: EventSourceName;
  sourceType: EventSourceType;
  receivedAt: Date;
  correlationId: string;
  payload: TPayload;
  meta: TMeta;            // [v0.2] carries sourceTrackingToken for loop prevention
  raw?: unknown;
}

export interface DetectedEvent<TPayload = unknown, TMeta = Record<string, unknown>> {
  id: string;
  name: EventName;
  invocationId: string;
  correlationId: string;
  source: EventSourceName;
  sourceType: EventSourceType;
  detectedAt: Date;
  detectorDurationMs: number;
  envelope: EventEnvelope<TPayload, TMeta>;
  metadata?: Record<string, unknown>;
}
```

`DetectedEvent` intentionally does not carry DetectorContext (ADR-007).

## 9.2 DetectorContext, HandlerContext (+ Hasura extension) [v0.2]

```ts
export interface DetectorContext<TPayload = unknown, TSourceContext = unknown, TMeta = Record<string, unknown>> {
  eventName: EventName;
  invocationId: string;
  correlationId: string;
  envelope: EventEnvelope<TPayload, TMeta>;
  source: EventSourceName;
  sourceType: EventSourceType;
  sourceContext: TSourceContext;
  log: DetectorLogger;
  metadata: Record<string, unknown>;
}

export interface HandlerContext<TPayload = unknown, TMeta = Record<string, unknown>> {
  invocationId: string;
  correlationId: string;
  event: DetectedEvent<TPayload, TMeta>;
  envelope: EventEnvelope<TPayload, TMeta>;
  source: EventSourceName;
  sourceType: EventSourceType;
  log: HandlerLogger;
  metadata: Record<string, unknown>;
  signal?: AbortSignal;
}

// [v0.2] Hasura source handler context — DATA only, no columnChanged().
export interface HasuraHandlerContext<TNewRow = Record<string, unknown>, TOldRow = TNewRow>
  extends HandlerContext<HasuraEventPayload<TNewRow>> {
  operation: HasuraOperation;
  oldRow: TOldRow | null;
  newRow: TNewRow | null;
  row: TNewRow | TOldRow | null;       // newRow ?? oldRow ?? null
  role: string | null;
  userId: string | null;
  userEmail: string | null;
  receivedAt: Date;                    // replaces parseHasuraEvent().hasuraEventTime
}
```

Handlers are typed through the source, symmetric with detectors: `hasuraEvent.handler<MoveRow>(async (event, ctx) => { ... })` where `ctx` is `HasuraHandlerContext<MoveRow>`.

## 9.3 Loggers (tiered) [v0.2]

```ts
export interface DetectorLogger { debug(message: string, data?: Record<string, unknown>): void; }
export interface HandlerLogger {
  debug(m: string, d?: Record<string, unknown>): void;
  info(m: string, d?: Record<string, unknown>): void;
  warn(m: string, d?: Record<string, unknown>): void;
  error(m: string, err?: unknown, d?: Record<string, unknown>): void;
}
export type JobLogger = HandlerLogger;
```

Detectors get `debug` only (they must stay side-effect-light); handlers and jobs get full structured levels. Plugins decide where logs go (console, Grafana, observability tables, durable output). The runtime MUST route framework-internal logs (detection, plugin-system, **timeout handling**) to a plugin hook (`onLog`/`onJobLog` as appropriate) so observability/Grafana coverage is not silently lost — preserving the current `onLog` breadth.

## 9.4 job(), JobOptions, JobContext — the data channel [v0.2, Amendment A]

```ts
export interface JobOptions<TInput = undefined> {
  name?: string;
  timeoutMs?: number;
  retries?: number;
  tags?: string[];
  // continueOnFailure?: boolean;  // DEFERRED (ADR-031) — only alters series execution, not enabled this release
  // [v0.3.1] No `durable` field. Durability is NOT a core concept — it is emergent from registering
  // the Batch plugin in the kit (§12). Core JobOptions never names batch.
  /** Request-scoped data handed to the job. NEVER persisted, logged, or serialized.
   *  Live clients, closures, old/new rows belong here. */
  input?: TInput;
  /** Serializable annotations. Persisted by Batch, recorded by Observability. MUST be JSON-serializable. */
  metadata?: Record<string, unknown>;
}

export type JobFunction<TInput = undefined, TResult = unknown> =
  (ctx: JobContext<TInput>) => Promise<TResult> | TResult;

export function job<TInput = undefined, TResult = unknown>(
  fn: JobFunction<TInput, TResult>,
  options?: JobOptions<TInput>,
): JobDefinition<TInput, TResult>;

export interface JobContext<TInput = undefined, TPayload = unknown, TMeta = Record<string, unknown>> {
  invocationId: string;
  correlationId: string;
  event: DetectedEvent<TPayload, TMeta>;
  envelope: EventEnvelope<TPayload, TMeta>;
  input: TInput;                       // typed, request-scoped (Amendment A)
  trackingToken: string;               // [v0.2] outbound provenance token (§13)
  job: {
    id: string;
    name: JobName;
    attempt: number;
    options: JobOptions<TInput>;
    metadata: Record<string, unknown>; // serializable only — never the live `input`
  };
  log: JobLogger;
  progress(value: number, metadata?: Record<string, unknown>): Promise<void>;
  checkpoint(name: string, metadata?: Record<string, unknown>): Promise<void>;
  signal?: AbortSignal;
}
```

Normative:
- The runtime MUST pass `options.input` to `ctx.input` by reference, without cloning or serializing.
- Batch and Observability MUST read only `ctx.job.metadata`/`options.metadata`, never `ctx.input`.
- When the Batch plugin is registered (durability active, §12), the runtime SHOULD fail fast if `metadata` is non-serializable. *(There is no `durable` flag — §9.4 above, [v0.3.1].)*

`JobProgress`/`JobCheckpoint` shapes:

```ts
export interface JobProgress { value: number; /* 0..1 */ at: Date; metadata?: Record<string, unknown>; }
export interface JobCheckpoint { name: string; at: Date; metadata?: Record<string, unknown>; }
```

`progress(value)` takes a fraction in `[0,1]`. Checkpoints are named milestones a durable job records so a resumed/retried attempt can skip completed work.

## 9.5 run(), RunOptions — defaults pinned [v0.2, Amendment D]

> **[v0.3.9 — ADR-025] `run()` is now runtime-internal.** Consumers no longer call `run()`; a module *declares* its `jobs` and the runtime executes them. The signature below is the internal executor (`runJobs`), kept here for the contract it enforces. `RunOptions` are supplied on the module as `run: {…}` (e.g. `defineEvent({ …, run: { timeoutMs: 30_000 } })`), not as a third argument. The per-job overrides via `JobOptions` (§9.4) are unchanged.

```ts
export async function run<TPayload = unknown, TMeta = Record<string, unknown>>(
  event: DetectedEvent<TPayload, TMeta>,
  jobs: JobDefinition[],
  options?: RunOptions,
): Promise<JobExecution[]>;

export interface RunOptions {
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
  // DEFERRED — specified but NOT accepted in the initial release (ADR-014 as amended by ADR-031):
  //   mode?: 'parallel' | 'series';   // planned; every module runs 'parallel' for now
  //   continueOnFailure?: boolean;    // planned; only alters 'series' execution
}
```

- Jobs always run **parallel with isolated failures**: a job failure MUST NOT prevent, cancel, or skip another; `run()` MUST return a complete `JobExecution[]` with both successes and failures (matching the `Promise.allSettled` fan-out).
- **[v0.3.18, ADR-031] Configurable execution mode is deferred.** `run.mode` (`'series'`) and `continueOnFailure` (module- and per-job) are specified but MUST NOT be enabled in the initial release — the runtime MUST run every module's jobs in parallel, and the public `RunOptions`/`JobOptions` types MUST NOT expose them. Rationale: series invites sequential inter-job coupling (one job ordered before, or feeding, another), reintroducing the handler-style control flow ADR-025 removed, with more abuse risk than value. ADR-014 still fixes parallel+isolated as the behavior; ADR-031 removes the series opt-in for now. If reintroduced, it returns behind this same `run.mode` API so existing modules are unaffected.
- **[v0.3] No conditional job entries (reverses v0.2).** `jobs` is a strict `JobDefinition[]`. The runtime MUST NOT accept or silently skip falsy/conditional entries — `run()` MUST throw a clear error on any non-`JobDefinition`, and the type makes `cond && job(...)` a compile error. This deliberately breaks the current `cond && job(fn, ...)` idiom (≈14 sites): per §3.9 and ADR-018, conditional behavior belongs in the detector (a named event) or inside the job (input-driven), never as a hidden handler branch. A lint rule flagging `&&`/ternary/`.push` inside a `run([...])` argument is RECOMMENDED as a second line of defense.

## 9.6 JobExecution, SerializedError [v0.2]

```ts
export interface JobExecution<TResult = unknown> {
  id: string;
  jobName: JobName;
  eventId: string;
  eventName: EventName;
  invocationId: string;
  correlationId: string;
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

export type JobExecutionStatus =
  | 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'timed_out' | 'cancelled';

// [v0.2] Defined (was referenced-only). Core owns serialization utilities.
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: SerializedError;
  data?: Record<string, unknown>;
}
export function serializeError(error: unknown): SerializedError;
export function serializeOutput<T>(output: T): unknown;          // circular-ref-safe
export function replaceCircularReferences<T>(value: T): unknown; // promoted from batch into core
```

`'timed_out'` = a job exceeded `timeoutMs`. `'cancelled'` = the AbortSignal fired (serverless budget exhausted or shutdown) before completion. `'skipped'` = not executed (**reserved** for the deferred series short-circuit — ADR-031; not produced while execution is parallel-only). These MUST be distinguishable in records.

## 9.7 createEventKit, EventKit, RequestContext, InvocationContext [v0.2, Amendment C]

```ts
// [v0.3] Constructed once at module scope with its single, required source.
// [v0.3.5] The source is the first positional arg — same (plugin, config?) shape as kit.use().
// No object wrapper: createEventKit(hasuraEvent) or createEventKit(webhook, { verify }).
// Everything else — the optional platform + all observer/transform plugins — via kit.use(plugin, config?).
export function createEventKit(source: EventKitPlugin | PluginFactory, config?: unknown): EventKit;

type PluginFactory = (config?: any) => EventKitPlugin;

export interface EventKit {
  // [v0.3.4] Pass the plugin/factory itself (NOT called) + optional config; the kit
  // instantiates it. A bare plugin object is also accepted. (See §11.4.)
  use(plugin: EventKitPlugin | PluginFactory, config?: unknown): EventKit;   // chainable
  registerEvent(module: EventModule): EventKit;
  registerEvents(modules: EventModule[] | Record<string, EventModule>): EventKit;
  validate(): void;                                 // explicit; also run on first handle()

  // Two entry styles (§9.8):
  // 1. Zero-boilerplate: the platform adapter owns the runtime signature & response.
  handler(opts?: { before?: (...args: any[]) => unknown | Response | void }): (...args: any[]) => unknown;
  // 2. Manual: forward the raw platform args; the adapter extracts payload + budget.
  //    Without an adapter, pass a RequestContext yourself.
  handle(rawPayloadOrArgs: unknown, request?: RequestContext | unknown): Promise<InvocationResult>;
  shutdown(): Promise<void>;

  // [v0.3.19, ADR-032] Read-only structural snapshot: source, platform, plugins, and every
  // registered event with its static job set. Pure — resolves plugins but runs nothing.
  // Feeds the flow generator (@hopdrive/eventkit/flow) and the eventkit-flow CLI.
  describe(): KitDescription;
}

export interface RequestContext {
  invocationId?: string;              // override; runtime generates if absent
  correlationId?: string;             // else derived from source (e.g. Hasura trace_context) or generated
  sourceFunction?: string;            // e.g. 'db-moves' — client-name + observability attribution
  getRemainingTimeMs?: () => number;  // serverless time budget — normally supplied by the platform adapter (§9.8), rarely hand-written
  pluginConfig?: Record<string, Record<string, unknown>>; // per-request plugin overrides, keyed by plugin name
  meta?: Record<string, unknown>;
}

export interface InvocationContext<TPayload = unknown, TMeta = Record<string, unknown>> {
  invocationId: string;
  correlationId: string;
  sourceFunction?: string;
  source: EventSourceName;
  sourceType: EventSourceType;
  envelope: EventEnvelope<TPayload, TMeta>;
  request: RequestContext;            // per-request config reaches every plugin here
  startedAt: Date;
  signal: AbortSignal;
  log: HandlerLogger;
}

export interface InvocationResult {
  ok: boolean;
  invocationId: string;
  events: Array<{ name: EventName; detected: boolean; jobs: JobExecution[] }>;
  durationMs: number;
  timedOut?: boolean;
  error?: SerializedError;
  // [v0.3.11, ADR-026] Request/response outcome for modules that declare `resolve`.
  // The platform adapter maps this to the wire response (output → 2xx; error → status/4xx).
  resolved?: {
    hasResolved: boolean;
    output?: unknown;
    error?: { message: string; status?: number; code?: string; extensions?: Record<string, unknown> };
  };
}
```

`createEventKit()` MUST be safe to call once at module scope and reuse across warm invocations. Plugins are constructed once there; per-request data reaches them via `InvocationContext`, eliminating per-invocation `register(...)`.

## 9.8 Platform Adapters [v0.3.2, ADR-021]

A **PlatformAdapter** normalizes a deployment runtime's invocation into the shape EventKit expects. It is the **plugin kind that provides the optional singleton `'platform'` capability** (§11.0, §11.1 Shape 3) — a narrowly-scoped plugin that answers a different question than the source: *how did the runtime hand us this request, how long may we run, and what response shape does it expect back?* Like any plugin it declares `name`/`provides`/`requires` and lives in its own flat folder under `src/plugins/platform-<name>` (e.g. `src/plugins/platform-lambda`, `src/plugins/platform-netlify`), the folder name equal to its `name`. It is **optional** (auto-detected/none if absent) and registered like any other plugin via `kit.use(netlifyPlatform)` — not a `createEventKit` param (§11.4).

```ts
export interface PlatformAdapter<TArgs extends any[] = any[], TResponse = unknown> {
  name: string;
  provides: Capability[];                              // ['platform'] — the singleton capability this plugin fills (§11.0)
  requires?: Capability[];
  detect?(): boolean;                                  // true if this adapter matches the current runtime (env-based)
  extractPayload(...args: TArgs): unknown | Promise<unknown>;   // raw body → the source adapter's input
  buildRequest(...args: TArgs): RequestContext;        // invocationId, correlation, sourceFunction, and getRemainingTimeMs
  formatResponse(result: InvocationResult): TResponse; // InvocationResult → the platform's expected return
}
```

The adapter is the **only** place that touches platform specifics. `extractPayload` reads `event.body` (classic) or `await request.json()` (Web). `buildRequest` supplies the time-budget closure (below) and any correlation hints the runtime exposes. `formatResponse` returns `{ statusCode, body }` or a Web `Response` as appropriate. Event modules, handlers, jobs, and other plugins never see any of this.

### Time-budget strategy (the `getRemainingTimeMs` question, generalized)
Every runtime falls into one of three buckets; the adapter collapses all three into the single `RequestContext.getRemainingTimeMs` closure (or omits it):

- **A — Native countdown.** AWS Lambda, Netlify classic (Lambda-backed): `getRemainingTimeMs = () => context.getRemainingTimeInMillis()`. Precise cancellation and flush-before-kill.
- **B — Fixed timeout, no countdown.** Vercel, GCP, Azure, Cloudflare wall limits, Netlify v2: the adapter computes `getRemainingTimeMs = () => maxExecutionMs - (now - startedAt)` from a configured/known max.
- **C — No deadline.** Long-running servers, local/test: the adapter omits `getRemainingTimeMs`; the runtime treats the budget as unbounded and relies on per-job `timeoutMs` and graceful shutdown.

The runtime derives `InvocationContext.signal` and observability/batch flush timing from whatever `getRemainingTimeMs` the adapter provides — so cancellation and best-effort flush work uniformly across A/B/C without any platform code leaking into business logic.

### Provided adapters
The package ships four — `lambdaPlatform()` and three Netlify flavors (classic / v2 / background, detailed just below):
- **`lambdaPlatform()`** — raw AWS Lambda `(event, context)`; bucket A via `context.getRemainingTimeInMillis()`; `formatResponse` → `{ statusCode, body }`.
- **`netlifyPlatform()`** — Netlify **classic** Functions `(event, context)`; bucket A (Lambda-backed); reads `event.httpMethod`/`event.body`; returns `{ statusCode, body }`.

### Netlify needs more than one adapter (the "differences" plan)
Netlify's function flavors differ enough in shape that they get **separate adapters**, not one fuzzy `netlifyPlatform()`:
- **`netlifyPlatform()`** — classic v1 `(event, context)`, `{ statusCode, body }`, bucket A. *(db-* functions today.)*
- **`netlifyV2Platform()`** — modern v2 `(Request, Context)` Web standard; returns a `Response`; treated as **bucket B** unless the v2 context is confirmed to expose a live countdown. *(reverse-integration repos.)*
- **`netlifyBackgroundPlatform()`** — Background Functions: ~15-minute budget, returns `202` immediately, response body ignored. Bucket A with a long budget; this is the flavor that powers the live `batch_jobs` watch view (§12.6). *(db-batchjobs.)*

Authoring a new runtime (`vercelPlatform()`, `cloudflarePlatform()`, `denoPlatform()`, `nodePlatform()`/Express) is implementing the four-method contract above — and is the recommended path rather than hand-wiring `getRemainingTimeMs` per function. The runtime SHOULD `detect()` the platform from env (`AWS_LAMBDA_FUNCTION_NAME`, `process.env.NETLIFY`, `VERCEL`, absence of `process` for Workers, …) and, if a deadline-capable platform is detected but no adapter is registered, **warn once at init** so a missing/incorrect budget wiring is visible rather than silent.

### Entry styles
With an adapter registered (`kit.use(netlifyPlatform)`), a function body is either fully owned by the kit or a thin forward:
```ts
// 1. zero-boilerplate — the adapter owns the signature & response
export const handler = kit.handler();

// 2. manual — when you need a pre-check (auth) before dispatch
export const handler = async (event, context) => {
  if (!auth.hasValidPassphrase(event)) return { statusCode: 401, body: 'Unauthorized!' };
  return kit.handle(event, context);   // adapter extracts payload + budget from the raw args
};
```
The explicit `RequestContext` form (`kit.handle(payload, { getRemainingTimeMs, sourceFunction })`) remains the escape hatch for custom runtimes and tests where no adapter applies.

# 10. Job Execution (declarative module — ADR-025)

**[v0.3.9] There is no handler body.** A module *declares* a static `jobs` array; the **runtime** executes it. Optional `prepare(ctx)` runs once and is merged into every job's `ctx.input` (the migration vehicle for the legacy "init the sdk once, thread it into each job" pattern). Jobs SHOULD be idempotent; retried jobs MUST NOT produce duplicate externally-visible effects unless safe.

**Reference module (post-migration of `move.pickup.started`):**

```ts
export const movePickupStarted = defineEvent<MoveRow>({
  name: 'move.pickup.started',
  detector,                                   // the §3.2 switch-style detector
  // prepare runs ONCE; its result is merged into every job's ctx.input.
  prepare: hasuraEvent.prepare<MoveRow>((ctx) => {
    const sdk = initSdk();
    return { sdk, move: ctx.newRow, role: ctx.role, userId: ctx.userId };
  }),
  // A STATIC array — no conditionals, no run() call. Bare fns auto-wrap to job(fn).
  jobs: [
    publishGenericWebhook,
    handleSMSInitiation,
    runAR,
    job(runARV2, { metadata: { eventKey: MOVE_PICKUP_STARTED_EVENT_KEY } }),
  ],
});
```

**No conditional entry.** The legacy `driverStatusIsActionable && … && job(sendDriverSilentPushNotification, …)` site is **not** expressible here (there is no handler to branch in, and a `false | JobDefinition` entry is a compile error — §9.5). It migrates one of two ways (§19.1): promote it to its **own event** (a `move.driver_status.actionable` detector + module whose single job is the push), or fold the guard **inside** the job (`sendDriverSilentPushNotification` early-returns when the condition doesn't hold). Both keep the branch *visible* — to observability and Flow Manifests — which a hidden handler conditional would not.

The internal executor (`runJobs`, §9.5) owns execution semantics: building JobContext, emitting plugin callbacks, retries, timeouts, honoring AbortSignal cancellation, collecting outputs, serializing errors, returning records. Retries are owned semantically by core; durability (persisting/scheduling retries) is owned by Batch. Timeouts may be set per-job (`timeoutMs`) or per-run (the module's `run: {…}`); the runtime SHOULD propagate cancellation through AbortSignal.

# 11. Plugin Architecture

Plugins are infrastructure extensions; they MUST NOT be required for core detection/handling to work. Registered once at startup. Hooks are called in registration order unless a hook defines otherwise.

## 11.0 One extension concept — the plugin — in three kinds [v0.3.14, ADR-027]

There is exactly **one extension concept in EventKit: the plugin.** Everything that extends the framework is a plugin that declares `name`, `provides` (the capability it fills), and `requires` (capabilities it depends on), and contributes through the hook shapes in §11.1. Plugins differ only in **which capability they provide** — that gives three *kinds*:

| Kind | Capability (`provides`) | Cardinality | Specialized interface | Examples |
|---|---|---|---|---|
| **Source plugin** | `'source'` | required, exactly one per kit | `SourceAdapter` (§7) | `hasuraEvent`, `hasuraCron`, `hasuraAction`, `webhook` |
| **Platform plugin** | `'platform'` | optional, at most one | `PlatformAdapter` (§9.8) | `lambdaPlatform`, `netlifyPlatform`, `netlifyV2Platform`, `netlifyBackgroundPlatform` |
| **Observer / transform plugin** | none (or a non-singleton tag) | zero or more | `EventKitPlugin` (§11.2) | `observability`, `batch`, `loopGuard`, `grafana`, `sentry` |

A **source** and a **platform** are therefore just *narrowly-scoped plugins*: each owns a single Shape-3 singleton capability (the source provides `normalize` + the detector/handler contexts; the platform provides `extractPayload`/`buildRequest`/`formatResponse`). They keep their specialized interfaces (`SourceAdapter`/`PlatformAdapter`) for the capability-specific methods, but they are plugins — they declare `name`/`provides`/`requires` and may also implement the lifecycle notifications/transforms like any plugin.

**[v0.3.14] Code organization mirrors the model — a FLAT `src/plugins/` directory.** Every plugin lives in **its own folder directly under `src/plugins/<name>`**, with **no subcategory folders**. The naming convention is **`<type>-<name>`, dash-case, type-first**, and the **folder name is exactly the plugin's `name` property** (not merely similar):

- **sources** — `source-hasura-event`, `source-hasura-cron`, `source-hasura-action`, `source-webhook` (each Hasura adapter is its *own* plugin folder; shared payload parsing/types/context-builders live in a non-plugin `hasura-shared/` support folder)
- **platforms** — `platform-lambda`, `platform-netlify`, `platform-netlify-v2`, `platform-netlify-background`
- **observer/transform** (no shared capability type, so no prefix) — `observability`, `batch`, `loop-guard`, `grafana`, `sentry`

Each declares its own `name` (= folder) / `provides` / `requires`. The factory **export** name stays idiomatic camelCase (`hasuraEvent`, `netlifyPlatform`) — that's the JS function, a separate axis from the folder/`name`. Support files alongside the plugins: `hasura-shared/`, `platform-shared.ts`, and the barrels `source-hasura.ts` / `platforms.ts` for the `./sources/hasura` / `./platforms` public entries.

**`name` (plugin identity) vs `envelope.source` (recorded source).** The plugin `name` is its folder-aligned registration identity (`source-hasura-event`). The *recorded* source — `envelope.source` and the observability `source_system` — is the **normalized envelope's** source set by the adapter (`'hasura'`, `'webhook:stripe'`): the meaningful "what came in" identity, deliberately distinct from the verbose plugin name. The runtime derives the invocation's recorded source from the envelope, not from the plugin `name`.

The **public subpath imports stay short and stable** (`./sources/hasura`, `./platforms`, `./plugins/observability`, `./plugins/transports/grafana`) — the `exports` map decouples the public path from the internal folder (§17), so flattening + renaming the source tree changed no consumer import. Registration is unchanged: the required source is the typed positional arg `createEventKit(hasuraEvent)` (the one compile-time "exactly one source" guarantee, D19); the platform and every other plugin register via `kit.use(plugin, config?)`.

## 11.1 Composition model [v0.3.3, ADR-022]

The most important rule: **the built-in default for every step always runs. Plugins layer around it; they do not subclass or override it.** "Default behavior plus a little extra" is the common case and the *native* mode — replacement is the rare exception. A plugin hook is exactly one of **three shapes**, and the shape determines both the composition rule and the naming:

**Shape 1 — Notification (`onX`, returns `void`).** "Something happened; observe it." Fans out to every plugin in registration order. Cannot change a value. Two sub-forms by what they bracket:
- **Spans** use `Start`/`End`: `onInvocationStart`/`onInvocationEnd`, `onJobStart`/`onJobEnd`, … (a phase with a duration).
- **Points around a built-in capability** use `Before`/`After`: `onBeforeNormalize`/`onAfterNormalize`, … — this is how a plugin does *a little extra side-effect* before or after a built-in step without altering its result.

Plugin self-lifecycle is also notification-shaped: `onInit` (once, at kit build / first `handle`), `onFlush` (flush buffers), `onShutdown`. (These replace today's bare `initialize`/`flush`/`shutdown`.)

**Shape 2 — Delta transform (bare verb, returns a partial; runtime merges).** "Contribute to a value the runtime is assembling." The runtime computes a base, then applies each plugin's returned partial in registration order with documented precedence. The default always contributes; plugins only add — so this shape is *inherently* "default + extra," never replacement. Members: `configureInvocation` (→ `Partial<RequestContext>`), `augmentEnvelope` (→ envelope refinements after the source builds it), `augmentJobContext` (→ `{ input?, context? }`). Per ADR-020, handler-supplied `options.input` wins over plugin `input` baselines.

**Shape 3 — Singleton capability (bare verb, exactly one provider).** "Own this step." Declared via `provides` (below); the runtime enforces uniqueness. Members: `normalize`, `buildDetectorContext`, `buildHandlerContext` (the source), `extractPayload`, `buildRequest`, `formatResponse` (the platform). This is the only shape where replacement is even possible. To **reuse the default while replacing it**, the runtime injects the default implementation as the trailing `base` argument — **dependency injection, not inheritance** (no `extends`, no `super`): a custom `normalize(raw, request, base)` calls `base(raw, request)` then tweaks. Most "default + extra" needs are met by an `onAfter…` notification (Shape 1) or an `augment…` transform (Shape 2); Shape-3 replacement is the escape hatch.

**Capability declaration.** Two distinct optional fields (these supersede the muddled `requires: { sourceType }` of v0.3.1):
- `provides?: Capability[]` — singleton roles this plugin fills (e.g. `['source']`, `['platform']`). The runtime throws at `onInit` if two plugins claim the same singleton.
- `requires?: Capability[]` — singletons this plugin depends on (e.g. Batch `requires: ['source:hasura']`). Validated at `onInit`.

### The naming rule
`on…` (void) ⇒ a notification you observe — `Start/End` for spans, `Before/After` for capability brackets. A **bare verb** ⇒ the runtime calls you to *get a value back*: a delta transform (Shape 2) or a singleton capability (Shape 3). The prefix tells you the contract: `on…` = fire-and-forget; verb = returns something, order/merge/uniqueness matter. (This is why v0.2's `configureInvocation` is renamed `configureInvocation` — it returns a value — and why `augmentJobContext` was always a verb.)

## 11.2 Interface

```ts
export interface EventKitPlugin {
  name: string;
  provides?: Capability[];   // singleton roles filled, e.g. ['source'] | ['platform']  (uniqueness enforced)
  requires?: Capability[];   // singleton roles depended on, e.g. ['source:hasura']

  // ── Shape 1: notifications (void) ──
  onInit?(ctx: KitContext): Promise<void> | void;                 // once, at kit build / first handle
  onInvocationStart?(ctx: InvocationContext): Promise<void> | void;
  onInvocationEnd?(ctx: InvocationContext, result: InvocationResult): Promise<void> | void;
  onEventDetectionStart?(ctx: DetectorContext): Promise<void> | void;
  onEventDetectionEnd?(ctx: DetectorContext, result: DetectionResult): Promise<void> | void;
  onEventHandlerStart?(ctx: HandlerContext): Promise<void> | void;
  onEventHandlerEnd?(ctx: HandlerContext, result: HandlerResult): Promise<void> | void;
  onJobStart?(ctx: JobContext): Promise<void> | void;
  onJobProgress?(ctx: JobContext, progress: JobProgress): Promise<void> | void;
  onJobCheckpoint?(ctx: JobContext, checkpoint: JobCheckpoint): Promise<void> | void;
  onJobLog?(ctx: JobContext, entry: LogEntry): Promise<void> | void;
  onJobEnd?(ctx: JobContext, execution: JobExecution): Promise<void> | void;
  onLog?(entry: LogEntry): Promise<void> | void;                  // framework-level logs (detection, runtime, timeout)
  onError?(ctx: ErrorContext): Promise<void> | void;
  onBeforeNormalize?(raw: unknown, request: RequestContext): Promise<void> | void;  // capability brackets (side-effect only)
  onAfterNormalize?(envelope: EventEnvelope): Promise<void> | void;
  onFlush?(): Promise<void> | void;
  onShutdown?(): Promise<void> | void;

  // ── Shape 2: delta transforms (return a partial; runtime merges base + deltas) ──
  configureInvocation?(request: RequestContext, envelope: EventEnvelope): Partial<RequestContext> | void;
  augmentEnvelope?(envelope: EventEnvelope): Partial<EventEnvelope> | void;
  augmentJobContext?(ctx: JobContext): { input?: Record<string, unknown>; context?: Record<string, unknown> } | void;

  // ── Shape 3: singleton capabilities (one provider; `base` is the default, injected for reuse) ──
  normalize?(raw: unknown, request: RequestContext, base?: NormalizeFn): EventEnvelope;
  buildDetectorContext?(envelope: EventEnvelope, base: DetectorContext): unknown;
  buildHandlerContext?(envelope: EventEnvelope, base: HandlerContext): unknown;
  extractPayload?(...args: any[]): unknown | Promise<unknown>;
  buildRequest?(...args: any[]): RequestContext;
  formatResponse?(result: InvocationResult, base?: FormatFn): unknown;
}

export interface ErrorContext {
  error: SerializedError;
  phase: 'normalize' | 'detect' | 'handle' | 'job' | 'plugin';
  invocationId: string;
  correlationId: string;
  eventName?: EventName;
  jobName?: JobName;
}
```

> **Relationship to source/platform adapters (§7, §9.8).** A `SourceAdapter` is a plugin whose distinguishing hooks are the Shape-3 capabilities `normalize`/`buildDetectorContext`/`buildHandlerContext` (`provides: ['source']`); a `PlatformAdapter` is one whose distinguishing hooks are `extractPayload`/`buildRequest`/`formatResponse` (`provides: ['platform']`). Resolved registration (ADR-019, §11.4): the **source** is `createEventKit`'s first positional arg (`createEventKit(hasuraEvent)` — required singleton, compile-time guaranteed); the **platform** and every other plugin register via `kit.use(plugin, config?)`. The composition model above is the shared backbone regardless.

## 11.3 Before → after: the prebuilt plugins under this model

| Plugin | Today (`hasura-event-detector`) | Under the composition model | Shapes used |
|---|---|---|---|
| **tracking-token** | `onPreConfigure` — *mutates* the payload by reference and returns option overrides to inject the correlation id | `configureInvocation` (delta: correlation id + `sourceTrackingToken`) + `augmentJobContext` (ambient `ctx.trackingToken`). No mutation. | 2 |
| **observability** | `onInvocationStart/End`, `onEventDetection*`, `onJobStart/End`, `onError`; buffers; `flush` | same notifications + `onFlush`; pure observer | 1 |
| **batch** *(new)* | the separate `batchJob()` execution wrapper | `augmentJobContext` (inject the row's `input`) + `onJobStart/End`/`onJobLog`/`onError` + `onFlush`; `requires: ['source:hasura']` | 1 + 2 |
| **grafana** | `onLog` (+ the `scoped-job` wrapper for correlation) | `onLog` + `onJobLog` + `onFlush`; correlation comes from the context, not a wrapper | 1 |
| **sentry / slackAlerts** | `onError` | `onError` (+ `onFlush`) | 1 |
| **hasura source** | *was the framework itself* | `normalize` + `buildDetectorContext` + `buildHandlerContext`; `provides: ['source']` | 3 |
| **netlify / lambda platform** | *hard-coded entry assumptions* | `extractPayload` + `buildRequest` + `formatResponse`; `provides: ['platform']` | 3 |

The headline change: **tracking-token stops mutating the payload** (its `onPreConfigure` side-effect) and instead contributes deltas — the single biggest correctness improvement, since payload mutation was the least predictable part of the old model. `order-enrichment` (today an `onPreConfigure` mutator) migrates the same way: to `augmentEnvelope` (Shape 2) instead of mutating `hasuraEvent` by reference.

Normative:
- **[v0.2]** Plugins MUST augment context only through typed extension contracts (`augmentJobContext`, `augmentEnvelope`, `configureInvocation`, source/handler context), never by mutating a shared options object or the payload (ADR-012).
- **[v0.3.1] Job-context contribution and input merge (ADR-020).** Before each job runs, the runtime calls `augmentJobContext` on every registered plugin in registration order. The runtime MUST resolve `ctx.input` as `{ ...pluginInputBaselines, ...options.input }` — plugin baselines first (registration order), then the handler-supplied `options.input` on top (handler keys win). This lets a plugin supply data to a job (e.g. Batch injecting the triggering `batch_jobs` row's `input`) without the job or handler referencing the plugin. The job reads `ctx.input` and stays plugin-agnostic (§3.10).
- **[v0.3.1]** `kit.use(plugin)` / `kit.validate()` MUST enforce a plugin's declared `requires` and throw at init if unmet (e.g. Batch without the Hasura source).
- Observability/durability write failures SHOULD NOT fail the invocation unless the application opts into strict mode. Which hooks are best-effort vs fatal MUST be documented per plugin.
- Plugins SHOULD be idempotent (retries, duplicate deliveries) and use stable IDs/upserts.
- **[v0.2]** Plugins MUST NOT block hot hooks with synchronous network I/O; see §13.
- **[v0.2] `onLog` breadth.** The runtime MUST emit framework-internal logs (detection, plugin-system, timeout handling) to `onLog` so Grafana/observability coverage matches today's behavior, where `onLog` captured all levels including timeouts.

## 11.4 Registration: `kit.use(plugin, config?)` [v0.3.4, ADR-019]

Plugins register by passing the **plugin (or its factory) itself, not a call**, with config as a second argument; the kit instantiates it:

```ts
kit.use(observability, { graphql: { endpoint, adminSecret } });   // factory + config
kit.use(trackingToken, { extractFromUpdatedBy: true });
kit.use(netlifyPlatform);                                         // no config → no ceremony
kit.use(grafana);
```

Rationale: the factory-call form (`kit.use(observability({...}))`) forces an empty `()` on every zero-config plugin and puts instantiation in the caller's hands. `use(plugin, config?)` removes the ceremony and lets the **kit own instantiation** — so it can inject kit-level context (its logger, the resolved source/platform) into the plugin at build, validate config against the plugin's schema, and enforce `provides`/`requires` uniqueness, all at `onInit`. A bare already-constructed plugin object is also accepted (`use(plugin)`), so trivial plugins need no factory.

**The one required singleton — the source — is `createEventKit`'s first positional arg** (`createEventKit(hasuraEvent)`, or `createEventKit(webhook, { verify })` when it needs config), same `(plugin, config?)` shape as `use()` (ADR-019). A kit cannot function without exactly one source, and a required positional arg makes that a compile-time guarantee. The **platform is optional** (auto-detected/none if absent, §9.8) and therefore registers like any other capability via `kit.use(netlifyPlatform)`. *(If a future decision prefers total uniformity, the source can also move to `use(hasura)` with the guarantee downgraded to a `validate()` check — see ADR-019 alternatives.)*

# 12. Batch Plugin [v0.2, Amendment E]

Batch is a durability plugin: it persists execution state, coordinates durable retries, manages delayed attempts, records retry history, and exposes operational state. Split: **core** owns execution/retry/timeout semantics and context construction; **Batch** owns persisted state, retry scheduling/history, delayed-retry metadata, lifecycle state transitions, and integration with existing `batch_jobs` records.

**[v0.3.1] Durability is emergent from registration — there is no core `durable` flag.** A job becomes durable for one reason only: the Batch plugin is registered in its kit. The plugin is registered **only in the `db-batchjobs` function** (whose source is the `batch_jobs` table) and nowhere else, so jobs in other functions never gain the behavior. Registering it makes *every* job in that kit durable automatically — the equivalent of today's `batchJob(...)` wrapper applied by virtue of registration. The plugin `requires` the Hasura source (it is, at bottom, a Hasura DB event on `batch_jobs` with an expected record shape) and `kit.use()` throws at init if that source is absent.

## 12.1 Record model
`batch_jobs` row: `{ id, batch_id?, delay_ms?, delay_key?, sequence?, type?, status, input, output, created_at, updated_at }`.

```ts
export type BatchJobStatus =
  | 'pending' | 'ready' | 'delaying' | 'processing' | 'done' | 'error' | 'timeout';
```

## 12.2 Two distinct concerns (kept separate)
1. **Durable execution (consumer).** An invocation triggered by a `batch_jobs` row runs jobs whose lifecycle is persisted to that row. No per-job flag — durability is on because the plugin is registered (§12 intro). The plugin replaces the legacy `batchJob(...)` wrapper.
2. **Enqueue (producer).** A normal job persists a *new* `batch_jobs` row for later execution — an ordinary DB side-effect the Hasura source picks up on a subsequent invocation. Batch is **not** a source adapter (explicitly rejected in planning). Enqueue is an ordinary insert; an optional `batch.enqueue(...)` helper is sugar over it, not a coupling.

## 12.3 Automatic input injection; the job stays batch-unaware [v0.3.1, ADR-020]
The defining rule (§3.10): **the job knows nothing about batches.** There is no `durable` flag, no `batch.record(...)`, no `ctx.batch.record`. The plugin does two things automatically for every job in the kit:

1. **Injects the record's `input` as the baseline `ctx.input`** (via `augmentJobContext`, §11). The handler does not map `ctx.newRow.input` — the plugin reads the triggering row from the envelope and contributes it. Handler-supplied `input` (typically just live deps) is shallow-merged on top, overriding on key collision: `ctx.input = { ...row.input, ...options.input }`.
2. **Persists state, output, and logs back to the row** by self-correlating its `id` from the envelope.

So the consumer handler carries no batch boilerplate at all:
```ts
// events/batch.created.ap.ts (consumer for batch_jobs.type = 'ap')
export const handler = hasuraEvent.handler<BatchJobRow>(async (event, ctx) => {
  return run(event, [ job(runApBatch) ]);   // no flag, no input mapping — the plugin injects record.input
});
```
And the job is a plain job that would run identically with the same `input` from any caller:
```ts
import sdk from '@hopdrive/sdk';            // live deps come from module scope (or merged-in input)
export const runApBatch = async (ctx) => {
  const { input, log } = ctx;               // destructure off ctx; never chain ctx.log.info(...)
  const { workUnit } = input;               // workUnit arrived from the batch_jobs row automatically
  log.info('Processing AP batch work unit');
  return processAccessorialPayables(workUnit, sdk);   // returns output; the plugin persists it
};
```
If a job needs a live dep merged in per-call, the handler supplies it and it overrides the baseline: `job(runApBatch, { input: { sdk } })`. Batch MAY expose detector helpers scoped to `batch_jobs` row conventions (`batch.created(ctx)`, `batch.type(ctx, 'ap')`) for use inside `hasuraEvent.detector(...)` — detection helpers, not job coupling.

## 12.4 Persisted lifecycle (hook → status)
With the plugin registered, Batch observes the §11 hooks for every job and transitions the correlated `batch_jobs` row:

| Hook | batch_jobs effect |
|---|---|
| `onJobStart` | `status='processing'`, stamp started, record `attempt` |
| `onJobLog` | buffer; flush to `output` (circular-ref-safe) — at job end always, and periodically if configured (§12.6) |
| `onJobEnd` success | `status='done'`, write `output`, stamp completed |
| `onJobEnd` failure, attempts remain | `status='delaying'` then `'ready'` per retry schedule; record error |
| `onJobEnd` failure, attempts exhausted | `status='error'`, persist `SerializedError` |
| timeout / signal abort | `status='timeout'`, flush partial `output` |

Normative:
- Batch correlates the row from the envelope; it MUST NOT require the job or handler to identify the row.
- Batch MUST read only serializable data (`ctx.job.metadata`, the job's returned output) when writing `batch_jobs`; it MUST NOT read `ctx.input` (live channel, §3.8).
- Before writing `output`, Batch MUST apply `replaceCircularReferences` (§9.6).
- **Retry ownership (ADR-008):** core decides whether a retry happens (`retries`, attempt counting); Batch persists attempt state and schedules the delayed attempt (`'delaying'` + `delay_ms` → `'ready'`). Both surfaces MUST agree on `attempt`/`maxAttempts`.
- Batch' own write failures MUST be best-effort (logged/surfaced, not fatal to the job).

## 12.6 Log flushing (configurable) [v0.3.1]
End-of-job flush of buffered logs to `batch_jobs.output` is **mandatory**. **Periodic flushing while a job runs is optional config**, because a React view watches `batch_jobs.output` via an Apollo GraphQL subscription so operators can follow a long background job (up to ~15 min) live as its logs accumulate. The plugin exposes a flush policy; with none set, logs flush only at job end.

```ts
batch({
  graphql: { endpoint: cfg.graphqlUrl, adminSecret: cfg.graphqlSecret },
  logFlush: {
    intervalMs?: number;     // e.g. 2000 — periodic flush cadence for the live-watch UI
    everyNEntries?: number;  // e.g. 25  — or flush after N buffered log entries
    // end-of-job flush is always on, regardless of this config
  },
})
```

The runtime SHOULD coalesce periodic writes (single upsert per flush) and MUST still apply circular-reference replacement. Periodic flushing is a per-deployment cost/visibility trade-off; high-frequency jobs MAY leave it off and rely on end-of-job flush.

## 12.7 Migration shape
Consumer: `batchJob(async (_e, _h, options) => { const { batchJob } = options; const input = batchJob.input; ... })` → a plain `async (ctx) => { const { input } = ctx; const { workUnit } = input; ... }`. **Delete the wrapper, the flag, and the input mapping** — registering the plugin supplies the lifecycle and injects `input` from the row. The whole consumer handler is `run(event, [ job(runApBatch) ])`. Producer: direct `batch_jobs` inserts stay as-is (or use the optional `batch.enqueue(...)` helper). The AR invariant (enqueue and consume are separate invocations with separate failure semantics) is preserved.

# 13. Observability Plugin

Observability records runtime evidence without changing behavior. It records the Invocation → Event → Job hierarchy and answers "what happened" for an invocation/event/job/correlation ID/tracking token/flow.

Record contents (unchanged from v0.1): invocation, event, and job records with IDs, statuses, timings, errors, logs, checkpoints, progress, correlation, trace, **tracking token**, **source job ID when triggered by a previous job**, and runtime matching metadata `{ flowId?, expectedNodeId?, expectedEdgeId?, matchConfidence: 'exact' | 'inferred' | 'unmatched' }`.

**[v0.2] Performance is normative, not advisory.** The Observability plugin MUST buffer per-invocation and flush at `onInvocationEnd`/`onFlush`. It MUST NOT perform a synchronous network write per `onJobStart`/`onJobEnd` on the hot path. (Rationale: the current plugin uses `transport: 'graphql'`; a naive per-job write adds 200–400ms × N jobs × 245 functions.) Writes SHOULD be batched into as few round-trips as practical. A failed flush MUST NOT fail business execution unless strict mode is configured.

**[v0.2] `flush()` in serverless is best-effort.** Netlify/Lambda provide no guaranteed pre-termination hook. The runtime SHOULD derive an AbortSignal from `RequestContext.getRemainingTimeMs` and attempt a flush before the budget expires, but the spec MUST state that pre-kill flush is best-effort, and durable jobs MUST rely on `batch_jobs` state (not observability) for recovery.

**[v0.2] Loop prevention (tracking token) is a control mechanism, not just a logged field.**
- **Inbound:** the Hasura adapter (or a tracking-token plugin at `configureInvocation`/`onInvocationStart`) MUST extract provenance from `updated_by` into `envelope.meta.sourceTrackingToken`. Detectors/handlers MAY read it to suppress self-triggered work.
- **Outbound:** the runtime MUST expose a deterministic `ctx.trackingToken = ${source}.${correlationId}.${ctx.job.id}` for jobs that write to the DB; jobs stamp it into `updated_by` so the next invocation recognizes the write as system-originated and can suppress a loop.
- This makes the existing `TrackingTokenExtractionPlugin` behavior a specified part of the contract rather than an undocumented dependency. Re-homing it is correctness-critical: a mistake here produces production event storms.

Redaction: the plugin SHOULD support payload redaction and payload-by-reference. **[v0.2]** The reference format (how a stored reference resolves back to a payload, and how the Console renders a redacted field) MUST be specified before the Observability plugin ships.

# 14. Expected Flow, Observed Flow, and Compare Mode

Expected Flow is the contract; Observed Flow is the evidence; Compare Mode is the truth-finding layer. Compare Mode MUST NOT block production execution. Classifications and matcher priority order are as in v0.1 (`expected_missing`, `optional_not_taken`, `condition_not_met`, `observed_success`, `observed_failed`, `unexpected_observed`, `retrying`, `timed_out`, `cancelled`, `out_of_order`, `extra_invocation_chain`; matcher priority: explicit `expectedNodeId` → `flowId`+name → event name → job name → source+stage → inferred → unmatched). The matcher MUST preserve uncertainty (`matchConfidence='inferred'`, unmatched stays visible).

**[v0.2] Phasing caveat (recovers a planning nuance).** The matcher and Compare Mode are a **hypothesis to validate against one real flow before broad investment**. They MUST be sequenced **behind** the runtime migration (Amendments A–E) and proven on a single high-value flow (e.g. mobile-service-dispatch) before being generalized. Stable node IDs MUST NOT be derived from file paths alone (paths change in refactors); use event/job names and explicit IDs.

**[v0.3.19 — ADR-032] The Expected-Flow *generator* is now SHIPPED; Compare Mode is still phased.** The structural half of this triad is in the package today. `kit.describe()` plus `@hopdrive/eventkit/flow` (`toFlowGraph`/`toFlowYaml`) build the Expected graph straight from the declarative modules, and the Observability records already give us the Observed evidence. What's still phased is the matcher/Compare join and the Console UI on top of it. That's planned in `console-expected-flows.md`, and it still has to be proven on one flow first. The generator emits stable node ids that don't depend on file paths (`source`, `event:<name>`, `job:<event>:<job>`, `sideEffect:<job>:<effect>`), so the eventual overlay lines up.

# 15. Flow Manifests and Architecture Metadata

A Flow Manifest is a source-controlled business-process contract describing intent, not implementation. The manifest describes meaning; the generator verifies structure. Manifest/type shapes (`FlowManifest`, `FlowNode`, `FlowEdge`; node kinds `source|invocation|event|handler|job|sideEffect|terminal`) are as in v0.1. Flow tooling SHOULD validate manifests in CI (schema, duplicate IDs, edge endpoints, node kinds, terminal reachability, code-reference validation, generated-graph comparison, strictness levels).

**[v0.3.19 — ADR-032] The generator side is implemented; manifests stay hand-authored.** The `FlowNode`/`FlowEdge`/`FlowManifest` types now ship from `@hopdrive/eventkit` (core), and `toFlowGraph(kit)` in `@hopdrive/eventkit/flow` emits the structural `{ nodes, edges }` skeleton in exactly that vocabulary. So a generated graph can be diffed against a hand-authored manifest, or promoted into one. `kit.describe()` is the pure registry walk underneath. `toFlowYaml(kit)` is the committed human-readable form. The `eventkit-flow` CLI (`generate`/`check`) produces the artifact from a consumer repo and gates it in CI. What the generator *can't* infer is cross-event chains (a job's DB write triggering another kit's event) and business intent, and that's exactly what the hand-authored manifest still owns. The one piece still phased here is manifest **CI validation** (the schema, reference, and generated-graph checks above).

# 16. EventKit Console

The Console evolves from an observability viewer into an architecture explorer (Observed / Expected / Compare modes). Node types, states, and visual semantics are as in v0.1. **[v0.2]** The machine-readable APIs (`GET /flows/:flowId`, `GET /observations/:invocationId`, `GET /compare/:flowId/:invocationId`) require a backend host and a query layer over the Observability storage; that backend MUST be specified (host, auth, storage queries) before the Console ships. Observed Mode is useful before Flow Manifests exist and SHOULD ship first.

**[v0.3.19] Console plan captured.** The Expected graph is now a shipped, committed artifact (ADR-032), and the Observed records already exist. So the remaining work is the three Console modes, the matcher/Compare join, the backend read API, and the shared node-id contract that makes the overlay line up. All of that is planned in **`console-expected-flows.md`**. The Console itself stays phased (D9). Prove Compare on one flow before generalizing.

# 17. Package Structure and Public API

EventKit is published as `@hopdrive/eventkit` with optional capabilities behind subpath exports. **[v0.3.15] Import the family barrels** (`./sources`, `./platforms`, `./plugins`) for clean, few-line imports — the package is `sideEffects`-free, so esbuild/Netlify tree-shake away whatever a function doesn't name:

```ts
import { createEventKit, defineEvent, job } from '@hopdrive/eventkit';
import { hasuraEvent } from '@hopdrive/eventkit/sources';        // + hasuraCron, hasuraAction, webhook
import { netlifyPlatform } from '@hopdrive/eventkit/platforms';  // + lambdaPlatform, netlifyV2Platform, …
import { observability, graphqlSink, batch, loopGuard, grafana } from '@hopdrive/eventkit/plugins';
```

The shipped subpaths are: `.` (root), `./core`, **`./sources`** (all source plugins), **`./plugins`** (all observer/transform plugins), `./platforms` (all platform plugins), plus the granular paths for the tightest bundle — `./sources/hasura` (exports `hasuraEvent`/`hasuraCron`/`hasuraAction`), `./sources/webhook`, `./plugins/batch`, `./plugins/observability` (+ `./plugins/observability/graphql-sink`), `./plugins/loop-guard`, `./plugins/correlation-resolver`, `./plugins/transports/grafana`, `./plugins/transports/sentry`, `./testing`, and **`./flow`** (the flow-doc generator: `describeKit`/`toFlowGraph`/`toFlowYaml`; §14 to §16, ADR-032). `"sideEffects": false` lets the family barrels tree-shake; the granular subpaths remain for functions that want to pin exactly one.

**[v0.3.19] The package also ships a bin, `eventkit-flow`** (`generate` / `check`), so a consumer repo can regenerate its committed flow doc in an npm script and CI-gate drift. See §14 and the guide's "Generated flow docs" section.

**[v0.3.14, ADR-027] Internal structure mirrors the "everything is a plugin" model (§11.0) — a FLAT `/plugins`.** Every extension is its own folder directly under `/plugins`, no subcategory folders; the folder name implies the kind:

```
/core  /runtime  /testing
/plugins
  /source-hasura-event  /source-hasura-cron  /source-hasura-action   (one plugin each)
  /source-webhook
  /hasura-shared          (adapter.ts, payload.ts, types.ts — shared, not a plugin)
  /platform-lambda  /platform-netlify  /platform-netlify-v2  /platform-netlify-background
  /observability          (+ observability/graphql-sink.ts)
  /batch
  /loop-guard
  /grafana  /sentry
  platform-shared.ts       (helpers shared by the platform flavors)
  source-hasura.ts         (barrel → ./sources/hasura)
  platforms.ts             (barrel → ./platforms)
```

Naming convention: **`<type>-<name>`, dash-case, folder === plugin `name` exactly** (`source-*`, `platform-*`; observer/transform plugins are unprefixed). The **public subpath names stay short and stable** (`./sources/hasura`, `./platforms`, `./plugins/observability`, `./plugins/transports/grafana`) regardless of the flat internal layout — the `exports` map decouples the public path from the internal folder, so flattening + renaming the source tree broke no consumer import. Public extension contracts: `SourceAdapter`, `PlatformAdapter`, `EventModule`, `EventKitPlugin`, `EventEnvelope`, `DetectorContext`, `DetectedEvent`, `HandlerContext`, `JobContext`, `JobExecution`, `RequestContext`, `InvocationContext`, `EventKit` (with `use()`/`registerEvents()`/`handler()`/`describe()`), `FlowManifest`, `FlowNode`, `FlowEdge`, `KitDescription`, `createEventKit()`, `defineEvent()`, `job()`, and (from `./flow`) `describeKit()`/`toFlowGraph()`/`toFlowYaml()`. *(`run()` is **not** a public export — the executor is runtime-internal, ADR-025.)* Provided platform adapters: `lambdaPlatform()`, `netlifyPlatform()`, `netlifyV2Platform()`, `netlifyBackgroundPlatform()` (§9.8). Semantic versioning; breaking changes to public contracts require a major version.

**[v0.2] Bundling validation is a release gate, not an assumption.** v0.1 reversed the planning decision (separate `@hopdrive/eventkit-*` packages) to a single package with deep subpath exports without recording the trade-off. Deep `exports`-map subpaths are a known "works locally, module-not-found at deploy" risk under Netlify's esbuild/zisi packager and the repo's `hopdrive-inline` step. Before adopting subpath exports, CI MUST include a Netlify-bundle smoke test that imports every subpath from a built function and resolves it in the packaged output. If that proves unreliable, the package family remains the fallback. (Note: this risk is in tension with §3.4's bundler-determinism rationale and MUST be resolved with evidence, not assertion.)

# 18. Configuration and Registration

**[v0.3] Register-style API (ADR-019).** `createEventKit()` takes the single source; plugins and events are added with `kit.use()` / `kit.registerEvents()`. This reads top-to-bottom like the old `pluginManager.register(...)` entrypoints it replaces, and each plugin's config is its own legible line.

```ts
const kit = createEventKit(hasuraEvent);   // required source — first positional arg (D14)

kit.use(netlifyPlatform);                                   // optional platform — registered like any capability (§9.8)
kit.use(observability, { graphql: { endpoint: cfg.graphqlUrl, adminSecret: cfg.graphqlSecret } });
kit.use(batch,     { graphql: { endpoint: cfg.graphqlUrl, adminSecret: cfg.graphqlSecret } });
kit.use(loopGuard, { field: 'updated_by', serviceId: 'event-handlers' });
kit.use(grafana, { logger: getLogger() });

kit.registerEvents(events);
```

The runtime SHOULD validate registration before the first invocation (duplicate event names, missing detectors/handlers, missing required plugin config/secrets, duplicate plugin names) — on first `handle()` or an explicit `kit.validate()` — so misconfiguration fails fast at boot, not mid-event.

**[v0.2] `EventModule.metadata` (recovers a lost concept).**

```ts
// [v0.3.9, ADR-025] Declarative module — no `handler` field; built via defineEvent({...}).
export interface EventModule<TPayload = unknown> {
  name: EventName;
  detector: DetectorFunction;
  prepare?: PrepareFunction;                      // runs once; merged into every job's ctx.input
  jobs?: (JobDefinition | JobFunction)[];         // static array; bare fns auto-wrap to job(fn)
  resolve?: ResolveFunction;                       // [v0.3.11, ADR-026] request/response output (concurrent with jobs)
  respond?: RespondFunction;                       // [v0.3.16, ADR-029] result-driven response (after jobs; { jobs, ok }); mutually exclusive with resolve
  run?: RunOptions;                                // timeoutMs/metadata (mode/continueOnFailure deferred — ADR-031)
  metadata?: EventModuleMetadata;                  // description, tags, owner, flowHints, deprecated, relatedDocs
}
// A module MUST declare `jobs` and/or a response seam (`resolve` OR `respond`) — a do-nothing module is a register-time error.
```

`metadata` is optional and feeds static analysis, Flow hints, and the Console. It is registration-time metadata on the module, distinct from runtime `DetectedEvent.metadata`.

**[v0.3.2] Netlify handler shape (with platform adapter).** The adapter (§9.8) extracts the payload, supplies the time budget, and shapes the response — no hand-written `getRemainingTimeMs`. Two equivalent forms:

```ts
// module scope — built ONCE per warm lambda (kit configured as above; platform via kit.use(netlifyPlatform))

// (1) zero-boilerplate — the adapter owns the (event, context) signature & response:
export const handler = kit.handler();

// (2) manual — when a pre-check must run before dispatch:
export const handler = async (event, context) => {
  if (event?.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  if (!auth.hasValidPassphrase(event)) return { statusCode: 401, body: 'Unauthorized!' };
  return kit.handle(event, context);   // netlifyPlatform() extracts JSON body + getRemainingTimeInMillis; sourceFunction inferred
};
```

# 19. Migration Strategy

Migration is incremental and preserves working behavior. **[v0.2]** The honest framing: detectors are minimal-change (already house style); handlers, jobs, `scoped-job`, plugins, and the test suite are a **rewrite, not a port**, and the AR/tracking-token/billing paths are correctness-critical.

Recommended phases:
1. Introduce `@hopdrive/eventkit` alongside the existing package; prove subpath bundling in CI (§17).
2. Build the Hasura source adapter, including `HasuraHandlerContext`, the column helpers (`columnChanged()` etc.), and inbound provenance extraction.
3. Port shared primitives: `job()`/`run()` with the `input`/`metadata` split and pinned defaults; loggers; `serializeError`/`serializeOutput`/`replaceCircularReferences`.
4. Implement the per-invocation entry (`createEventKit`/`handle`/`InvocationContext`) and the tracking-token plugin with the outbound stamping contract.
5. Migrate event modules one at a time to the declarative shape (ADR-025): convert `(e,h) => run(...)` into `defineEvent({ name, detector, prepare?, jobs, run? })`. The detector ports nearly verbatim (already the `switch` house style). The handler's shared setup (the near-universal `sdk.apollo.initialize(...)` + threading `sdk`/`user`/`role` into each job) becomes `prepare`; the `jobs.push(job(fn, bag))` lines become the literal `jobs` array. Preserve event name, detector semantics, job names, retry behavior, and observability identifiers unless a deliberate, recorded change is made.
6. Register the Batch plugin in the `db-batchjobs` function and migrate consumers off `batchJob(...)`: delete the wrapper, the flag, and the input mapping — the plugin injects the row's `input` and self-correlates. Migrate the ≈14 conditional-job sites per §19.1.
7. **Shadow-mode parity test** the AR/tracking-token/billing paths: run EventKit alongside the current runtime and diff outputs before cutover. Straight cutover is NOT acceptable for these paths.
8. Enable Observability capture (buffered) for migrated events; rewrite Grafana/Observability plugins against `EventKitPlugin`.
9. Add a Flow Manifest for one high-value workflow and validate generated metadata in CI (only after the runtime migration is stable).
10. Expand to remaining modules; introduce Compare Mode once one flow is proven.

**Compatibility facade (optional, highest-risk component — sequence honestly).** A facade re-exposing `run(eventName, hasuraEvent, jobs)` / `job(fn, dataBag)` must reconstruct a synthetic envelope and a JobContext that smuggles the old `(eventName, hasuraEvent, options)` args — i.e. reimplement the old runtime inside the facade — and still will not fix tests that import package internals directly. Treat it as a real engineering effort, not an early freebie; prefer per-module migration where feasible.

## 19.1 Conditional-job migration playbook [v0.3.9]

The declarative `jobs` array (ADR-025) makes conditional inclusion inexpressible, so the ≈14 sites that gate a job today must each move to one of two homes. The decision rubric is a single question: **does the condition decide *which business event occurred*, or merely *whether this one job has work to do*?**

**Pattern A — promote to a new event (condition = a distinct business fact).** When the gate expresses a sub-state that is really its own event, define a new event module whose *detector* encodes the condition; the gated job moves there, and both modules keep a constant job set. Example — `db-moves/move.active.change` today ends with a short-circuit:
```js
driverStatusIsActionable && !isFromDriver && !moveIsOperationallyDone &&
  jobs.push(job(sendDriverSilentPushNotification, { oldMove, newMove, sdk }));
```
That compound condition is a business fact — "a move became driver-actionable from a non-driver edit." Migrate it to a sibling event `move.driver-actionable` whose detector returns that boolean (named constants → sentence), with `jobs: [ job(sendDriverSilentPushNotification, …) ]`. `move.active.change` keeps its three unconditional jobs (`runAR`, `runARV2`, `runDriverPay`). The push notification now renders as its own node in the flow tooling.

**Pattern B — job-internal short-circuit (condition = data presence).** When the gate just means "this job has nothing to do for this row," keep the job in the static array and short-circuit at the top of the job body on its own input. Example — `db-outcomes/outcome.resolving` today does `if (driverId) jobs.push(job(notifyDriverOnResolution, …))`. Migrate to an unconditional `job(notifyDriverOnResolution, { input: ctx => ({ driverId: ctx.newRow.driver_id, … }) })` whose body opens with `const { driverId } = ctx.input; if (!driverId) return;`. The job always *runs* (and is observable as a run that no-op'd), but does nothing without a driver. This is the right home precisely because the absence of a driver is not a different event — it is the same `outcome.resolving` event with less to do.

**Choosing between them.** Pattern A when the condition combines business state (`isClientFacing`, `driverStatusIsActionable`) such that the *meaning* of the event differs — prefer it when the distinction is worth seeing in the flow. Pattern B when the condition is a nullable field whose absence simply skips work. When in doubt, prefer A for anything an operator would want to see as a distinct outcome, B for plumbing. Each of the ≈14 sites must be classified explicitly during migration and the choice recorded; never reintroduce the gate at the array level.

## 19.2 `app-*` → Hasura Action conversion playbook [v0.3.12]

The ~20 bespoke `app-*` / `build-*` / `get-*` / `save-*` endpoints are **converted to Hasura Actions** (each backed by a `hasuraAction` EventKit module), not migrated as HTTP endpoints. The motivation is security + observability (ADR-026): an Action is gated by Hasura's permission model instead of per-endpoint hand-rolled auth, and its downstream effects are correlation-traced. Conversion is **per-endpoint and gradual** — one endpoint, end to end, then the next. For each:

**1. Define the Action (Hasura metadata — via a `hasura-migrations` PR; never apply metadata directly).**
- Pick the **kind**: `query` for read endpoints (`app-get-full-offer-details`, `app-get-full-bundle`, `build-google-location-*`), `mutation` for commands with side effects (`app-handle-driver-registration`, `save-google-locations`, `app-post-fuel-reimbursement-accessorial`).
- Declare the **input type** from the endpoint's current request body, and the **output type** from its current success payload. These GraphQL types are *dependent code that must be authored* — they are the contract the caller and the handler both bind to.
- Point the action **handler** at the new EventKit function URL; configure forwarded headers if the handler needs them.

**2. Port the handler into a `hasuraAction` module.**
- `detector` matches `ctx.actionName`; `resolve(ctx)` carries the endpoint's existing logic (validation, the SDK query/mutation, response shaping) and **returns the output type**. Wrap expected failures in `ActionError(message, code?)` (→ the 4xx `{message, extensions}` Hasura surfaces); the **generic** platform adapter (`netlifyV2Platform` for v2 functions, else `netlifyPlatform`) maps `resolve`→2xx and the error→4xx — there is no dedicated action platform (§7.2, ADR-026 v0.3.11).
- Move shared setup (SDK init) into `prepare`; move any genuine fire-and-forget side effects (notifications, audit writes) into `jobs` so they're observability-traced rather than inlined into the response path.
- **Resolve the dependent code:** every helper the endpoint imports (payload mappers, dealership mapping, SDK GraphQL ops, validators) carries over, now called from `resolve`/`jobs`; the response-shaping code becomes the `resolve` return; the `JSON.parse(event.body)` + manual arg validation is replaced by the typed `ctx.input` (Hasura validated it against the input type).

**3. Replace hand-rolled auth with Action permissions.**
- The `app-*` endpoints each roll their own checks (`auth.hasValidMethod`, passphrases, ad-hoc role logic). Delete that; the handler now **trusts `ctx.sessionVariables`** because Hasura authenticated the JWT and authorized the action at the GraphQL layer.
- In the same `hasura-migrations` PR, **grant the action to the roles that should call it** (the action's permission list). Privileged behavior is now gated by RBAC, consistently.

**4. Verify caller access (the explicit "permissions verified" step).**
- Enumerate every **caller** of the endpoint (mobile app, web/admin, other services) — these are dependent code too.
- Confirm each caller authenticates through Hasura (JWT/session carrying the right role) and that the role is in the action's permission grant; verify per environment (local / test / production) before cutover.
- Switch each caller from the direct HTTP `fetch(<app-* URL>)` to the **GraphQL action** query/mutation. A caller without the granted role must be surfaced and resolved (grant the role, or reshape the action) — *do not* loosen the grant to "any logged-in user" to make a caller work.

**5. Shadow, then retire.**
- Run the Action handler alongside the still-live `app-*` endpoint and diff responses for representative inputs (including the auth-denied cases — confirm RBAC denies what the old hand-rolled check denied, no more, no less).
- Once parity holds and all callers are switched, **retire the `app-*` function**.

**Sequencing.** Do **queries before mutations** (read-only, reversible) and convert one low-risk endpoint end-to-end first (action def → module → permissions → a single caller switched → retire) to prove the full path — including the `hasura-migrations` PR loop and the permission verification — before fanning out. Track each endpoint's state (defined / ported / permissioned / callers-switched / retired) so a half-converted endpoint is never ambiguous.

# 20. Testing Strategy

Validate at multiple layers: detector unit tests (insert/update/delete, changed/unchanged columns, missing rows, **manual invocations**, malformed payloads); module tests (assert the declared `jobs` array is the expected, unconditional set — and that a conditional entry is a type/throw error per §3.9 — plus `prepare`/`resolve` where present); job tests (idempotency, retry safety, outputs, external errors, timeout, cancellation, reading `ctx.input` — including a plugin-injected baseline merged with handler input); plugin lifecycle tests (idempotency, failure handling, buffer/flush); source adapter normalization tests (incl. provenance extraction and `HasuraHandlerContext` construction); runtime integration tests through `createEventKit()`/`handle()`; flow tests; golden-trace tests for observability regressions.

**[v0.2]** The current test suite mocks the old call shape (`run` arity, `job(fn, options)` → `{fn, options}`, `options.jobName`, 2-arg detector calls). These mocks MUST be rewritten against the new contracts; the `jobName`-via-options assertion pattern maps to `JobOptions.name`/`metadata`. Shadow-mode parity (§19.7) is the primary safety net for money paths, above unit mocks.

# 21. CI Validation

TypeScript compile; lint; unit/integration tests; runtime API compatibility tests; Flow Manifest schema + code-reference validation; generated-graph validation; architecture-artifact drift detection; package-boundary enforcement; dependency-graph checks. **[v0.2]** Add the Netlify subpath-bundle smoke test (§17). Strictness levels: local=warn, PR=strict, release=release. Generated artifacts (`flows.json`, `flows.mmd`, `package-graph.json`, `event-graph.json`, `data-graph.json`) MUST match committed artifacts in strict/release.

# 22. Architecture Decision Records

ADR-001…010 are unchanged from v0.1 (source-agnostic; Hasura is a source adapter; event modules are the primary authoring experience; one detector per module; explicit registration; EventEnvelope/DetectedEvent separation; DetectedEvent does not carry DetectorContext; core owns retry / Batch owns durability; one package with subpath exports; Expected/Observed flows separate). New in v0.2:

## ADR-032: The Expected-Flow generator ships in-package; the manifest/Compare halves stay phased. [v0.3.19]

Decision: we ship the **structural** half of the Expected/Observed/Compare triad (§14 to §16) as real package surface, and hold the meaning and Compare halves for later. `kit.describe()` returns a pure `KitDescription` (source, platform, plugins, and every registered event with its **static** job set). It's a read-only registry walk that runs no detector, prepare, job, or hook. A new `@hopdrive/eventkit/flow` subpath turns that snapshot into artifacts: `toFlowYaml(kit)` (a committed YAML document of how events flow through the system), `toFlowGraph(kit)` (`{ nodes, edges }` in the `FlowNode`/`FlowEdge` vocabulary of §15), and `describeKit(kit)`. The `eventkit-flow` bin (`generate` / `check`) lets a consumer regenerate the doc in an npm script and gate drift in CI. Core now exports the `KitDescription`/`FlowManifest`/`FlowNode`/`FlowEdge` types, which also cleans up old doc-drift where §16 listed `FlowManifest` as exported even though it wasn't.

Rationale: this is the "generator verifies structure" principle (§15) made real. It only works because modules are declarative (ADR-025). A static `jobs` array with no conditional inclusion and no fan-out means the whole structure is knowable **without running anything**, so the generated graph can't lie about what a handler "might" do. We scoped it to what the package can actually know from one kit: source, event, jobs, plus side effects declared in job `metadata`. What it can't infer is cross-event chains (a job's DB write triggering another kit's event) and business intent. That stays with the hand-authored Flow Manifest (§15), and the matcher/Compare join and the Console UI stay phased (D9, planned in `console-expected-flows.md`). Node ids come from event and job names, never file paths (§14), so the Observed and Expected graphs line up later. And there are no new runtime dependencies, since the YAML emitter is built in.

Consequence: `EventKit` gains `describe()`. The package gains the `./flow` subpath and the `eventkit-flow` bin. `FlowNode`/`FlowEdge`/`FlowManifest`/`KitDescription` become public types. The structural half of D9 is now **resolved (shipped)**. Its manifest-CI, Compare, and Console-backend halves are still open and phased.

## ADR-011: Job input and job metadata are separate channels.
Decision: `job()` exposes `input` (request-scoped, live, never persisted) and `metadata` (serializable, persisted/recorded). Rationale: the current options bag carries live `sdk` clients and closures that cannot be serialized; durability/observability require a serializable channel; conflating them is the core incompatibility. Consequence: jobs read live deps from `ctx.input` and persisted annotations from `ctx.job.metadata`; the runtime never serializes `input`.

## ADR-012: Context augmentation is typed, not mutation-based.
Decision: plugins/sources augment context through typed extension contracts (`buildHandlerContext`, `augmentJobContext`, `ctx.trackingToken`), not by mutating shared options. Rationale: the current `scoped-job`/`jobExecutionId` mutation channel is hard to reason about and is deprecated by the plugin model. Consequence: `scoped-job.js` collapses; the per-request config path is `RequestContext`/`InvocationContext`.

## ADR-013: One module-scoped runtime; per-request data flows through handle().
Decision: `createEventKit()` runs once; `kit.handle(payload, request)` processes each invocation; per-request config travels in `RequestContext` and reaches plugins via `InvocationContext`. Rationale: per-invocation plugin registration leaks on warm lambdas and v0.1 left the entry point undefined. Consequence: `listenTo()` and `onPreConfigure` are replaced; `configureInvocation` is the sanctioned pre-detection config hook.

## ADR-014: jobs run parallel + isolated (series execution deferred — see ADR-031).
Decision: `mode='parallel'`, `continueOnFailure=true` by default. Rationale: the current runtime is `Promise.allSettled` (isolated fan-out); the money path depends on a flaky job not blocking billing. Consequence: series/stop-on-failure is opt-in and explicitly does not preserve current behavior.

**[v0.3.18 — ADR-031, amends ADR-014] Series execution is deferred; parallel is the only mode in the initial release.** The configurable `run.mode` switch (`'series'`) and its companion `continueOnFailure` (module- and per-job) are **specified but not enabled** — the public `RunOptions`/`JobOptions` omit them and the runtime runs every module's jobs in parallel with isolated failures. Rationale: series execution invites sequential inter-job coupling (one job ordered before, or feeding, another), which reintroduces the handler-style control flow ADR-025 removed and carries more abuse risk than value at launch; there is no current consumer that needs it. It remains a **possible future feature**: if a real, reviewed ordering need appears it returns behind this same `run.mode` API, so no existing module changes. (ADR-014's parallel+isolated behavior is unchanged — ADR-031 only removes the opt-in escape hatch for now.)

## ADR-015: Batch durability is emergent from registration; no core flag. [revised v0.3.1]
Decision: there is no `durable` field in core `JobOptions`. A job is durable iff the Batch plugin is registered in its kit; the plugin is registered only in the `db-batchjobs` function and applies to every job there. It `requires` the Hasura source. `batch.enqueue(...)` is optional sugar over an ordinary producer-side insert; Batch is not a source adapter. Rationale: a `durable: true` flag in core JobOptions means core knows batch exists — the coupling the plugin model exists to remove. Durability must be a property of which plugins are registered, invisible to core and to jobs. Consequence: removes `durable` (and the earlier v0.3 flag, and the v0.2 `durable: batch.record(...)`/`ctx.batch.record`); the consumer handler is `run(event, [job(fn)])`; input arrives via ADR-020. Supersedes both prior forms.

## ADR-027: Sources and platforms are narrowly-scoped plugins; one unified plugin model + code organization. [v0.3.14]
Decision: there is **one extension concept — the plugin** — in three *kinds* distinguished only by the capability they provide (§11.0): **source plugins** (`provides: ['source']`, the required singleton: `normalize` + detector/handler contexts), **platform plugins** (`provides: ['platform']`, optional singleton: `extractPayload`/`buildRequest`/`formatResponse`), and **observer/transform plugins** (zero-or-more lifecycle plugins). Every plugin declares `name`/`provides`/`requires`. The specialized interfaces `SourceAdapter` and `PlatformAdapter` are **kept** (not collapsed into one union) as the capability-specific shapes for the first two kinds — but they are understood and documented as plugins, and the **code is organized to match**: every plugin lives in its own folder **directly** under `src/plugins/` — a FLAT directory with **no subcategory folders**, **type-first dash-case names** with the folder === plugin `name` exactly (`source-hasura-event`, `source-hasura-cron`, `source-hasura-action`, `source-webhook`; `platform-lambda`, `platform-netlify`, `platform-netlify-v2`, `platform-netlify-background`; and the unprefixed `observability`, `batch`, `loop-guard`, `grafana`, `sentry`). Public subpath imports stay short and stable (`./sources/hasura`, `./platforms`, `./plugins/observability`, `./plugins/transports/grafana`) — the `exports` map decouples the public path from the internal folder. Registration is **unchanged**: the required source remains the typed positional arg `createEventKit(hasuraEvent)` (preserving the compile-time "exactly one source" guarantee of ADR-019/D19); the platform and all other plugins register via `kit.use(plugin, config?)`. Rationale: ADR-022 already classified sources/platforms as Shape-3 singleton-capability providers — i.e. they were always plugins; the source tree just didn't show it (sources under `/sources`, all four platforms crammed in one `platforms/index.ts`). Unifying the folder layout and the self-declaration makes the one model legible in code and docs alike. A **flat** `plugins/` (no `sources/`/`platforms/`/`transports/` subcategories) was chosen over a categorized tree: the plugin's *kind* is already carried by its `provides` capability and by a **type-first name** (`<type>-<name>`, dash-case) that implies it, so subcategory folders were redundant nesting. Each Hasura adapter is its own plugin folder (`source-hasura-event`/`-cron`/`-action`), not one grouped `hasura/` folder; shared Hasura parsing/types live in a non-plugin `hasura-shared/`. The **folder name equals the plugin `name` property exactly** (e.g. folder `source-hasura-event` ↔ `name: 'source-hasura-event'`); the factory export stays camelCase (`hasuraEvent`). The plugin `name` is the registration identity and is **distinct from the recorded source** (`envelope.source` / observability `source_system`), which the runtime takes from the normalized envelope (`'hasura'`, `'webhook:stripe'`) — so renaming plugins did not change observability data. Keeping the three interfaces (rather than one discriminated union) and the positional source keeps the change low-risk and preserves type safety + the required-source guarantee. Consequence (implemented): `src/sources/*` and `src/platforms/index.ts` became flat `src/plugins/<type>-<name>` folders (+ `hasura-shared/`, `platform-shared.ts`, and `source-hasura.ts`/`platforms.ts` barrels); transports flattened (`grafana`, `sentry`); the runtime now derives the invocation's recorded source from `envelope.source`; the `exports` map was repointed while keeping the public subpaths unchanged (bundle smoke resolves all 12). Done while unpublished (`0.1.0`), no consumer import changed. Alternative considered: collapse `SourceAdapter`/`PlatformAdapter`/`EventKitPlugin` into one discriminated union — deferred (more churn for marginal gain now); revisit if the three interfaces drift.

## ADR-026: Request/response source class — actions and RPC return a synchronous payload. [v0.3.10]
Decision: EventKit recognizes two source *classes*. **Fire-and-forget event sources** (`hasuraEvent`, `hasuraCron`, vendor `webhook`s that only need an ack) detect a business event and run a declarative `jobs` set whose results are recorded, not returned. **Request/response sources** (`hasuraAction`, and the `app-*` RPC endpoints in `event-handlers`) must return a computed payload to the caller. A request/response module adds a single **`resolve(ctx) => output`** that produces the response; `jobs` stay optional fire-and-forget side effects. The generic HTTP platform adapter (no dedicated action platform — v0.3.11 note below) maps `resolve`'s return → a 2xx body and a thrown `ClientError`/`ActionError(message, code?)` → the source's error envelope (for Hasura Actions: HTTP 4xx + `{ message, extensions: { code? } }`). `webhook` for a status-contract vendor (Stripe) is fire-and-forget but maps the outcome → an HTTP status the same way. Rationale: an action's purpose is to compute and return one value — overloading a job's output as the response would conflate the (sibling-ignorant, fire-and-forget) jobs model with synchronous resolution and reintroduce result-coupling; a dedicated `resolve` keeps the response explicit and the jobs model intact (ADR-025). `resolve` is **source-agnostic** (not action-only): any source may declare it and its platform adapter maps the result to the wire response. **Why run a request/response handler through EventKit at all** (vs. leaving it bespoke): (1) **observability** — the action's downstream effects (jobs, and DB writes that fire further `hasuraEvent` invocations) are traced with one correlation id back to the originating call, the same way for webhooks/crons/DB events; every entry point becomes the root of a visible chain. (2) **security** — a Hasura Action is gated by Hasura's permission model (grant a role the action's GraphQL field), replacing the uneven, hand-rolled auth of bespoke `app-*` endpoints. The full Hasura Action request/response contract is in §7.2. Consequence: `EventSourceType` gains `'action'`; `defineEvent` gains an optional `resolve`; ships the `hasuraAction` source; the bespoke `app-*` endpoints are **deprecated and replaced by actions over time, not migrated to EventKit**. **Sub-decision (ratified):** `resolve` mapper, not a designated job output.

**[v0.3.11 — IMPLEMENTED; amends the platform framing] No dedicated `hasuraActionPlatform`.** Transport and the response-contract are separate concerns that **compose** rather than fuse. The *platform* owns transport only (Netlify classic `{statusCode,body}` vs v2 `Response` vs Lambda); the response *contract* (an action's `output`→2xx, `ActionError`/`ClientError`→4xx `{message,extensions}`) is carried by the source-produced `InvocationResult.resolved` and applied by the **generic** HTTP platforms (`netlifyPlatform`/`netlifyV2Platform`/`lambdaPlatform`). A Hasura action is therefore `createEventKit(hasuraAction).use(netlifyPlatform)` — there is no per-contract platform. Rationale: a Hasura Action over Netlify has **no** transport difference from any other Netlify function — the Hasura-ness is purely the body/error shape, a source/caller contract that is identical on Lambda. Fusing them into a `hasuraActionPlatform` would force a combinatorial `contract × transport` matrix (`hasuraAction × {netlify, v2, lambda}`, `stripeWebhook × {…}`, …); composing keeps it `sources + platforms`. The generic platforms honor `resolved` (output → 2xx body, `ClientError` → its status, error → `{message,extensions}`), satisfying both the Hasura Action and the status-contract-webhook (Stripe) contracts; a framework-error 500 carries `{message}` for Hasura-readability.

## ADR-025: Event modules are fully declarative; the runtime runs the jobs. [v0.3.9]

**[v0.3.11 — amendment] A `jobs` entry may be a bare job function (sugar for `job(fn)`).** A bare function in `jobs` is auto-wrapped as `job(fn)` (no options) at register time, with its name from `fn.name`; wrap in `job(fn, {…})` only when you need options (`name`/`retries`/`input`/`timeoutMs`). This is a pure ergonomic relaxation that does **not** reopen the conditional-inclusion hole the brand guards: `cond && fn` is `false | JobFunction` and `cond && job(fn)` is `false | JobDefinition` — `false` is assignable to neither, so both still fail to compile; `null` and non-job objects (look-alikes) are still rejected at compile time and by the register/runtime backstop. The job set stays statically enumerable (a bare identifier is as analyzable as `job(fn)`), so observability/flow tooling is unaffected. `EventModule.jobs` widens to `(JobDefinition<any> | JobFunction<any>)[]`; the contract type-tests now accept a bare fn and a mixed array while keeping every conditional/garbage negative.

Decision: an event module is a declarative record — `defineEvent({ name, detector, prepare?, jobs, run? })` — **not** a handler that calls `run()`. The detector keeps the readable `switch (ctx.operation)` house style (named boolean constants → a sentence-like return; `case 'MANUAL': return false`). `jobs` is a **static array literal** of `job(fn, { input? })` entries; the **runtime** executes them during dispatch — there is no consumer-facing `run()` call inside a handler body. An optional `prepare(ctx) => shared` runs once before the jobs and returns request-scoped shared references (an initialized `sdk`, fetched rows, helper closures, `user`/`role`); the runtime merges that object into every job's `ctx.input` automatically. Merge precedence (lowest→highest): plugin baselines (ADR-020, e.g. Batch row `input`) → `prepare` output → the job's own `input`. Three hard rules:
1. **No conditional job inclusion.** Because `jobs` is a literal array, there is no handler body to put an `if`/ternary/`.push` in — the anti-pattern is impossible *by construction*, not merely caught by a type brand. Conditions have exactly two homes: the **detector** (a condition that means a *different business event occurred* → give it a name) or **inside a job** (input-driven branching that runs every time and may no-op on its own input).
2. **No fan-out.** The job set is fixed and deterministic. Data-driven multiplicity ("do this per element") is expressed *inside a job* (loop in the job body) or by writing rows that trigger further events — never by emitting N jobs from one event. The event chain stays statically enumerable.
3. **No inter-job dependencies.** Sibling jobs are mutually ignorant — none may read another's existence, result, ordering, or input. All run independently, in parallel with isolated failures (ADR-014; series execution is deferred — ADR-031). A job that "needs another job's result" is a modeling error: combine them, or chain via a DB write that triggers the next event.

Rationale: ADR-018's branded `JobDefinition[]` only caught `cond && job(...)`; imperative `if (x) jobs.push(...)` compiled and ran, so the job set was not statically knowable — defeating the observability / react-flow / Flow-Manifest goals that justify the rewrite. A literal `jobs` array makes the set analyzable without execution and makes the conditional anti-pattern inexpressible. Forbidding fan-out and inter-job deps keeps every chain deterministic and every job a context-free, reusable unit. Moving execution into the runtime also removes the only reason a free `run()` needed `AsyncLocalStorage` to reach invocation state (a moving part flagged in the Phase 1 review). Consequence: `run()` becomes runtime-internal (no longer a consumer export); `RunOptions` move onto the module as `run: {…}`; `prepare` is the migration vehicle for the near-universal legacy pattern of initializing the SDK once and threading it into every job (`appointment.ready.js` et al.). The ~248 modules convert their `(e,h) => run(...)` handlers to `{ prepare?, jobs }`; the ≈14 conditional-job sites migrate per the playbook in §19.1. Supersedes ADR-018's "handler returns a strict `JobDefinition[]`" framing with "module declares a static `jobs` array"; the branded `JobDefinition` + runtime throw remain as the second line of defense.

## ADR-024: Generic-by-config plugins ship built-in; the app layer holds only config presets + SDK-coupled plugins. [v0.3.8]
Decision: a plugin lives in **core** — shipped as a tree-shakeable subpath export of `@hopdrive/eventkit` (e.g. `./plugins/loop-guard`, `./plugins/transports/grafana`, `./plugins/transports/sentry`, alongside `./plugins/batch` and `./plugins/observability`) — iff its behavior is fully determined by injected config. It lives in a **HopDrive layer** only if it imports `@hopdrive/sdk-*`, knows domain tables (`moves`/`appointments`), or hardcodes a cross-service convention that cannot be expressed as config. By this test, **loop-guard/tracking-token** (a pure `source|correlationId|jobExecutionId` codec — the legacy `tracking-token.ts` imports nothing HopDrive — plus a configurable read/write field path, separator, and a service identity), **grafana**, and **sentry** are all generic → built-in, parameterized by config (`loopGuard({ field, codec, serviceId })`, `grafana({ logger })` or `grafana({ grafana: { endpoint, auth, labels } })`, `sentry({ dsn })`). Rationale: the "HopDrive-specific" label conflated a generic *mechanism* with the *config* it is given; the secrets-as-injected-config rule (plugins never read `process.env`; the app injects config — §11, ADR-013) is precisely what makes "generic plugin + injected config" possible, so almost nothing needs to hide in a separate package. The outbound loop-guard seam is already in core (`ctx.trackingToken` default `${source}.${correlationId}.${jobId}`, plugin-overridable — §13); the inbound read field is config. Consequence: **reverses the earlier plan** to home trackingToken/grafana/sentry in `@hopdrive/app-eventkit`. Phase 3 builds these as generic built-in subpath plugins. The HopDrive layer collapses to (a) config presets pinning the shared token format / `updated_by` field / service id so all repos stay mutually intelligible (data, not logic), (b) any genuinely SDK-coupled enrichment plugin, (c) the app's event modules (which already live in the consumer repos, not a shared lib). Whether `@hopdrive/app-eventkit` is a published package or just a shared config object in the consumer repos is deferred (D23, new); if it shrinks to config presets it may not warrant a package at all. **[v0.3.15] Family-barrel exports.** Alongside the granular subpaths, the package exposes aggregate barrels — `./sources`, `./platforms`, `./plugins` — and declares `"sideEffects": false`, so a consumer imports a whole family in one line and esbuild/Netlify tree-shake away whatever the function doesn't name. The granular subpaths remain for the tightest possible bundle; `graphqlSink` is also re-exported from `./plugins/observability` so a plugin and its default sink import from one path.

## ADR-023: Hasura source adapters named by transport — `hasuraEvent` and `hasuraCron`.
Decision: provide two Hasura-origin source adapters rather than "hasura + a generic cron." `hasuraEvent` handles DB event triggers (`sourceType:'database'`; rows/operation/columnChanged context); `hasuraCron` handles Hasura scheduled triggers (`sourceType:'cron'`; `scheduleName`/`scheduledAt`/`payload` context). Rationale: HopDrive's cron is a Hasura scheduled-trigger payload — a sibling of the DB-event payload, not a generic scheduler — so naming the adapters for their actual transport is honest and echoes the current package's `hasuraEvent` export; it also leaves a generic `'cron'` `sourceType` open for a future non-Hasura scheduler (a different adapter). Consequence: `createEventKit(hasura)` → `createEventKit(hasuraEvent)`; cron functions use `createEventKit(hasuraCron)`; authoring helpers split into `hasuraEvent.detector`/`.handler` and `hasuraCron.detector`/`.handler`. Both `provides: ['source']`; one source per kit.

## ADR-022: Plugin composition model — three hook shapes; default always runs; DI over inheritance.
Decision: every plugin hook is one of three shapes — (1) notification (`onX`, void; `Start/End` spans, `Before/After` capability brackets, `onInit/onFlush/onShutdown` self-lifecycle), (2) delta transform (bare verb returning a partial the runtime merges over a base: `configureInvocation`, `augmentEnvelope`, `augmentJobContext`), (3) singleton capability (bare verb, one provider via `provides`: `normalize`/`buildDetectorContext`/`buildHandlerContext`, `extractPayload`/`buildRequest`/`formatResponse`). The built-in default for every step always runs; "default + a little extra" is the native mode via shapes 1–2. Replacement exists only for shape 3 and reuses the default by **injecting it as a `base` argument** (DI), never via inheritance/`super`. `provides`/`requires` declare capability roles, validated at `onInit`. Naming rule: `on…` ⇒ void notification; bare verb ⇒ returns a value (order/merge/uniqueness matter). Rationale: matches a composability/DI preference over class polymorphism; makes the contract legible from the name; eliminates payload mutation (the old `onPreConfigure` footgun). Consequence: `onPreConfigure`→`configureInvocation`; `initialize/flush/shutdown`→`onInit/onFlush/onShutdown`; tracking-token and order-enrichment stop mutating the payload and contribute deltas; source/platform adapters are expressible as shape-3 capability providers.

## ADR-021: Runtime portability via a Platform Adapter contract.
Decision: deployment-runtime specifics (invocation signature, payload extraction, time budget, response shape) are abstracted behind a `PlatformAdapter` — an optional capability-providing plugin registered via `kit.use(netlifyPlatform)` (§11.4). The package ships `lambdaPlatform()` and `netlifyPlatform()`; the contract is open for `vercelPlatform()`, `cloudflarePlatform()`, etc. The time-budget question collapses into three adapter strategies — native countdown (A), computed deadline (B), none (C) — all surfaced as `RequestContext.getRemainingTimeMs`. Netlify's classic / v2 / background flavors differ enough to warrant separate adapters (`netlifyPlatform()`, `netlifyV2Platform()`, `netlifyBackgroundPlatform()`). Rationale: hard-coding `context.getRemainingTimeInMillis()` and `{statusCode,body}` locks the package to Netlify/Lambda and makes a one-line wiring mistake a silent footgun; an adapter makes portability declarative and supports detect-and-warn. Consequence: handlers become `kit.handler()` or a thin `kit.handle(...args)`; event modules/jobs are fully platform-agnostic; "EventKit" is genuinely runtime-independent.

## ADR-020: Plugins contribute to job context (input baseline + ambient) via augmentJobContext.
Decision: a plugin MAY implement `augmentJobContext(ctx)` to contribute a baseline `input` and/or ambient context fields before a job runs; the runtime merges plugin baselines first (registration order), then the handler's `options.input` on top (handler wins). Plugins declare hard deps via `requires`, validated at `kit.use()`. Rationale: this is how a plugin supplies data to a job (Batch injecting the `batch_jobs` row's `input`; trackingToken supplying `ctx.trackingToken`) without the job or handler referencing the plugin — preserving job independence (§3.10, ADR-017) while removing handler boilerplate. Consequence: jobs read `ctx.input` uniformly whether the data came from the handler or a plugin baseline; core gains one generic contribution step and still never names any specific plugin.

## ADR-017: Plugins integrate via lifecycle and self-correlate; jobs stay plugin-agnostic.
Decision: plugins do their work solely through the lifecycle interface, correlating runtime state from context IDs (invocation, envelope, job execution). Jobs/handlers never thread plugin objects to make a plugin function; a job behaves identically regardless of which plugins are loaded. Rationale: independence and reusability of jobs; the Observability plugin already works this way and Batch should match. Consequence: durability, observability, and tracking are all pure lifecycle observers; the only job-facing values are ambient ones the runtime populates (`ctx.log`, `ctx.signal`, `ctx.trackingToken`).

## ADR-018: Handlers are declarative job lists; no conditional job inclusion.
Decision: `run(event, jobs)` takes a strict `JobDefinition[]`; conditional inclusion (`cond && job(...)`) is a compile error and a runtime throw. Conditions live in the detector (a named event) or inside the job (input-driven). Rationale: a conditional handler branch is invisible to observability/react-flow and to Flow Manifests, defeating core EventKit goals; this also codifies long-standing team guidance that informal review failed to enforce. Consequence: reverses v0.2's "tolerate falsy entries"; the ≈14 existing conditional sites are refactored during migration. A lint rule is recommended.

## ADR-019: Register-style configuration; required source is a param, everything else `use(plugin, config?)`. [revised v0.3.4]
Decision: the one **required** singleton (the source) is `createEventKit`'s **first positional arg**, same `(plugin, config?)` shape as `use()` — `createEventKit(hasuraEvent)` or `createEventKit(webhook, { verify })` — giving a compile-time "exactly one source, required" guarantee with no object wrapper. Everything else — the **optional** platform and all observer/transform plugins — registers via `kit.use(plugin, config?)`, where you pass the plugin/factory itself (not a call) plus optional config and the kit instantiates it (§11.4). Events via `kit.registerEvents(events)`. Rationale: the nested-object config was unreadable and `sources: [hasura()]` didn't communicate intent; the symmetric `(plugin, config?)` shape for both `createEventKit` and `use` removes the empty-`()` ceremony, lets the kit own instantiation (inject kit-level context, validate config, enforce `provides`/`requires`), and gives one mental model for every extension; keeping the required source positional preserves the compile-time guarantee a `use()`-only model would downgrade to a runtime check. Consequence: resolves D14; `createEventKit({ source: hasuraEvent })` → `createEventKit(hasuraEvent)`; `kit.use(observability({...}))` → `kit.use(observability, {...})`; platform moves from a `createEventKit` param to `kit.use(netlifyPlatform)`. Alternative considered (total uniformity, source also via `use(hasura)`): rejected for now to keep the compile-time required-source guarantee, but it remains a one-line change if preferred.

## ADR-016: Loop prevention is a specified control mechanism.
Decision: inbound provenance is extracted from `updated_by` into `envelope.meta.sourceTrackingToken`; outbound `ctx.trackingToken` is deterministic and stamped into writes. Rationale: this is the system's defense against infinite event loops; v0.1 carried it only as an observability field. Consequence: the tracking-token contract is part of the framework spec; mis-homing it causes production event storms, so it is shadow-mode tested before cutover.
