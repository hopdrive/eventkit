# EventKit — Implementation Kickoff (seed for a fresh agent / new thread)

> **📦 HISTORICAL — the build described here is DONE.** EventKit is built (core runtime, `hasuraEvent`/
> `hasuraCron`/`hasuraAction`/`webhook` sources, all four platforms, the plugins, testing utils, ADRs
> 001–027). This file is the *original phased build plan*, kept for provenance. **For how the system works
> today, read `../../README.md`, the canonical RFC, and `design-rationale.md` — not this plan.** The phase
> descriptions below are pre-build future-tense and some name APIs that were superseded before shipping
> (noted inline where they'd actively mislead).

**Date:** 2026-06-28 · **Design state (at writing):** RFC v0.3.7 · **As shipped:** RFC v0.3.15
**Purpose:** Everything a new context window needed to start *building* EventKit. (The build is complete; see banner.)

---

## 0. Read order (do this first)

A fresh agent has only what's written down. Read, in order:
1. **This file.**
2. **`architecture.md`** — the canonical design and **source of truth** (revision **v0.3.15**; see its revision-history table). Read §0 (change map) first, then §7–§13 (the API surface) and §22 (ADRs).
3. **`design-rationale.md`** — the distilled *why* behind the final design (consumption evidence + the decisions and the alternatives they replaced).
4. **`design-change-log.md`** — CHG-1…13, the change-by-change *why* (continued in the RFC revision history through CHG-17).
5. **`decision-register.md`** — the decision register with current resolved/open status (read the STATUS block at top).
6. **Current source to port from / verify against:**
   - `hasura-event-detector/src/` — the legacy runtime (`handler.ts` = `run()`+`job()`; `plugin.ts` = plugin manager; `detector.ts`; `plugins/`; `helpers/tracking-token.ts`; `plugins/observability/`).
   - `event-handlers/functions/db-*/` — 245 consumer modules + `~lib/jobs` + `~lib/scoped-job.js` + `db-*.js` entrypoints.
   - `sparkserv-integration/functions/lib/spark/` — the reverse-integration pattern.
7. **Memory** (auto-loaded): `project_eventkit_rewrite`, plus house-style notes `feedback_destructure_over_chaining`, `feedback_event_detector_style`, `feedback_event_handler_conditional_in_detector`, `feedback_event_handler_module_shape`.

---

## 1. Is the design complete? — coverage map

**Decisions: captured.** Every architectural decision lives in one of:
- **RFC §22 ADRs** — 001–010 (v0.1 foundations, summarized) and **011–027** (full):
  011 input/metadata channels · 012 typed augmentation not mutation · 013 module-scoped runtime + `handle()` · 014 `run()` parallel+continueOnFailure default · 015 durability emergent from registration (no flag) · 016 loop-prevention mechanism · 017 plugins self-correlate / jobs plugin-agnostic · 018 declarative handlers (no conditional jobs) · 019 register-style API (positional source + `use(plugin,config?)`) · 020 `augmentJobContext` contribution · 021 platform adapters · 022 plugin composition model (3 hook shapes, DI not inheritance) · 023 `hasuraEvent`/`hasuraCron` · **024 generic plugins built-in (subpath exports)** · **025 fully declarative modules (`defineEvent`, no handler/`run()`)** · **026 `webhook`/`hasuraAction` sources + module-level `resolve` request/response** · **027 sources/platforms are narrowly-scoped plugins; unified `src/plugins/` code org**.
- **CHG-1…17** (CHG-1…13 in the changes doc; CHG-14…17 in the RFC revision history) — rationale + before/after.
- **D1…D23** (register) — see the register's STATUS block for resolved vs the few still-open process calls (D6, D10, D13).

**Verdict:** the *design* is decision-complete and internally consistent. It is **not yet implementation-ready** without closing §2 below.

---

## 2. Gaps between "design captured" and "buildable" (close these)

### 2a. Open decisions that GATE the public type freeze — decide before writing the interfaces
- **D19** — source registration: positional `createEventKit(hasuraEvent)` (C) vs `kit.use(hasuraEvent)` (B). **Default: C.**
- **D20** — `provides`/`requires` capability tokens: role-level (`'source'`) vs qualified (`'source:hasura'`). **Default: qualified** (BatchJobs must require Hasura specifically).
- **D22** — plugin instantiation timing under `use(plugin, config?)`: eager vs lazy. **Default: lazy** (at `validate()`/first `handle()`, so the kit can inject kit-level context + run `requires` checks).

### 2b. Open decisions that GATE cutover / packaging
- **D6** — shadow-mode parity for AR/tracking-token/billing paths. **Default: yes** (run both runtimes, diff, before cutover).
- **D7** — compatibility facade vs per-module migration. **Default: no facade; per-module.**
- **D8** — single package + subpath exports vs package family. **Default: single package + subpaths, gated on a Netlify-bundle CI smoke test** (if it fails, fall back to a package family).

> A fresh agent MAY proceed on these defaults if the human doesn't override — they are the recommendations in the register. Flag them for ratification but don't block on them.

### 2c. Helper types referenced but not fully frozen in the RFC (finalize in Phase 0)
`Capability`, `EventSourceName`, `EventSourceType` (the union exists), `JobDefinition`, `PluginFactory`, `NormalizeFn`, `FormatFn`, `KitContext`, `DetectionResult`, `HandlerResult`, `JobProgress`/`JobCheckpoint` (shapes sketched), `SerializedError` (shape defined), the `LogEntry`/logger interfaces (`DetectorLogger`/`HandlerLogger`/`JobLogger`), `EventModuleMetadata`. These are mechanical to finalize once D19/D20/D22 are set.

### 2d. Not-yet-specified delivery concerns
- **Repo/package location**: built in a fresh `@hopdrive/eventkit` repo (`/Users/robnewton/Github/eventkit`). **[ADR-024]** Generic-by-config plugins — loop-prevention/tracking-token, grafanaLogger, sentry — ship **built-in as subpath exports** of `@hopdrive/eventkit`, NOT in a separate package; each is parameterized by injected config. A HopDrive layer holds only (a) config presets pinning the shared token format / `updated_by` field / service id, (b) any genuinely SDK-coupled (`@hopdrive/sdk-*`) enrichment plugin, (c) the app's event modules (which live in the consumer repos). Whether that layer is a published `@hopdrive/app-eventkit` package or just a shared config object in the consumer repos is deferred (D23) — likely no package if it's only presets.
- **Build/exports**: dual ESM/CJS (the current package does), `exports` map for subpaths, types. Reuse the current repo's tsconfig.* setup as a starting point.
- **Console backend** (Flow/Compare APIs) — out of v1 scope; only an Observed-mode read over the observability tables if anything.

---

## 3. Phased implementation plan

Each phase lists what to build, the governing ADRs, and a done-bar. **Honest framing:** detectors port cheaply; handlers/jobs/`scoped-job`/plugins/tests are a rewrite; AR/tracking-token/billing are correctness-critical (§5).

**Phase 0 — Skeleton & type freeze.** Decide D19/D20/D22 (or take defaults); freeze the public types (§2c) in `@hopdrive/eventkit/core`; set up build, dual output, subpath `exports`, and the **Netlify-bundle CI smoke test** (D8). *Done:* `import { createEventKit, defineEvent, job } from '@hopdrive/eventkit'` resolves in a built Netlify function. *(As shipped: there is no public `run()` export — the executor is runtime-internal, ADR-025.)*

**Phase 1 — Core runtime.** `createEventKit(source, config?)`, `kit.use(plugin, config?)`, `registerEvents`, `validate`, `handle()`; `run()` (parallel + continueOnFailure default, strict `JobDefinition[]`, throws on falsy entry); `job()` with `input`/`metadata`; `JobContext`; lifecycle dispatch in registration order; `augmentJobContext` merge (`{...pluginBaselines, ...options.input}`); AbortSignal/timeout; `serializeError`/`serializeOutput`/`replaceCircularReferences`. ADRs 011,013,014,017,018,020. *Done:* a no-plugin kit detects + runs jobs in-memory with a fake source; unit tests for merge order, falsy-throw, timeout/cancel.

**Phase 2 — `hasuraEvent` source adapter.** `normalize` (Hasura DB-event payload → EventEnvelope), `buildDetectorContext` (`operation`/`oldRow`/`newRow`/`row`/`columnChanged/columnAdded/columnRemoved` — *as shipped, the operation-predicate helpers `inserted/updated/deleted/manuallyInvoked` were removed in favor of the `switch (ctx.operation)` style*), `buildHandlerContext` (`HasuraHandlerContext`: operation/oldRow/newRow/role/userId/receivedAt), and the authoring exports `hasuraEvent.detector<T>()` / `hasuraEvent.prepare<T>()` *(there is no `.handler` helper — modules are declarative, ADR-025)*. ADRs 012,023. Detector style = **`switch (ctx.operation)`** house style (CHG-13). *Done:* `appointment.ready` detector compiles and passes detector unit tests (insert/update/delete/manual/malformed).

**Phase 3 — Plugins + composition model.** Implement the 3-shape `EventKitPlugin` contract (notification `on…` / delta transform / singleton capability; DI-injected `base` for replacement) + `provides`/`requires` validation at `onInit`. Then:
- `observability()` (buffered, flush at `onInvocationEnd`/`onFlush`; Invocation→Event→Job; best-effort).
- `batchJobs()` — **registration-emergent durability**: `augmentJobContext` injects the `batch_jobs` row's `input`; lifecycle hooks drive `processing→done/error/timeout`; configurable periodic log flush; `requires:['source:hasura']`. No `durable` flag.
- **Built-in generic plugins (ADR-024)** — config-driven, shipped as subpath exports of `@hopdrive/eventkit`:
  - `loopPrevention({ field, codec, serviceId })` — inbound reads the configured field (HopDrive: `updated_by`) into `envelope.meta.sourceTrackingToken`; outbound stamping is the core `ctx.trackingToken` seam (already in Phase 1). The `source|correlationId|jobExecutionId` codec is generic (separator + validation are config).
  - `grafanaLogger({ logger })` or `grafanaLogger({ grafana: { endpoint, auth, labels } })` and `sentry({ dsn })` — generic observability transports; secrets/endpoints arrive via injected config (plugins never read `process.env`). *(The export is `grafanaLogger`, not `grafanaTransport`.)*
- HopDrive layer is config presets (token format / `updated_by` / service id) + any SDK-coupled enrichment plugin + event modules — see §2d / ADR-024. Do NOT build a `@hopdrive/app-eventkit` package for trackingToken/grafanaLogger/sentry.
ADRs 015,016,017,019,020,022,024. *Done:* a durable consumer runs as a plain job reading `ctx.input`, state persisted to `batch_jobs`; observability records written once per invocation; `loopPrevention` configured with `field:'updated_by'` round-trips a token inbound→outbound.

**Phase 4 — Platform adapters.** `netlifyPlatform()` (classic) + `lambdaPlatform()`; then `netlifyV2Platform()` + `netlifyBackgroundPlatform()` for reverse integrations. Three time-budget strategies; `kit.handler()`; detect-and-warn. ADR-021. *Done:* a `db-*` function runs via `kit.handler()` with no hand-written `getRemainingTimeInMillis`.

**Phase 5 — `hasuraCron` source adapter.** Hasura scheduled-trigger payload → envelope; detector ctx `scheduleName`/`scheduledAt`/`payload`. ADR-023.

**Phase 6 — First real migration + shadow mode.** Migrate one `db-*` function (recommend `db-appointments`, module `appointment.ready`) end-to-end; build the **shadow-mode parity harness** (D6) and diff against the current runtime for AR/tracking-token paths. *Done:* outputs match in shadow; observability + loop-prevention verified; then cut over.

**Phase 7 — Expand `db-*`.** Migrate remaining modules; **refactor the ≈14 conditional-job sites** (§3.9/ADR-018) into named events or input-driven jobs; rewrite the test mocks.

**Phase 8 — Reverse integrations.** Migrate the `external-integration-template` first (webhook source adapter, `jobs/` decomposition, **vendor HTTP-status mapping** via typed `ClientError`/`netlifyV2Platform` — shadow-test it), then sparkserv → super-dispatch → central-dispatch → carsarrive → plateau.

**Phase 9 — Tooling (phased, after runtime proven).** Flow Manifests + Compare Mode on ONE high-value flow; Observed-mode console read API. ADRs 010,021. Don't build speculatively.

---

## 4. Critical correctness guards (do NOT regress — these fail silently)
1. **`run()` default = parallel + `continueOnFailure:true`** (ADR-014). A flaky job must not block `runAR`/`runARV2` (billing).
2. **Loop prevention / tracking token** (ADR-016) — mis-homing causes production event storms. Shadow-test.
3. **Vendor HTTP-status contract** (reverse integrations) — wrong status → vendor retry storms or dropped events. Shadow-test.
4. **No conditional jobs in handlers** (ADR-018); **jobs plugin-agnostic**, **no payload mutation** (ADR-017/012); **MANUAL suppression** preserved (`case 'MANUAL': return false`).
5. **Event names preserved verbatim** during migration (no opportunistic renames — breaks observability history).

## 5. Definition of done (v1)
Core + `hasuraEvent` + `observability` + `batchJobs` + built-in `loopPrevention` + `netlifyPlatform` shipping; **one `db-*` function fully migrated and passing shadow-mode parity**; detector/handler/job/plugin unit tests; the Netlify-bundle CI smoke test green; the ≈14 conditional-job sites in the migrated function refactored.

## 6. House style (from memory — apply throughout)
Destructure over chained refs (`const { input, log } = ctx`); detector = `switch (ctx.operation)` with named booleans per case + sentence return; handlers are declarative job lists; jobs read `ctx.input`, log via `ctx.log`; `${x ?? 0}` stringify; event-handler module = thin jobs-array builder (no business logic/SDK init/DB writes); Hasura changes via PR to hasura-migrations; invoke `hopdrive-ui:designer` for any UI (the Console).

---

## 7. One-paragraph brief to paste into the new thread
> *(Historical seed — the build is done. Kept verbatim for provenance.)* Build the EventKit package per `architecture.md` (source of truth, now revision v0.3.15) and this kickoff plan. Decisions are captured in the RFC ADRs 001–027, the design-changes log (CHG-1…13 + CHG-14…17 in the RFC revision history), `design-rationale.md`, and the open-decisions register. Start at Phase 0: take the recommended defaults for the open decisions D19 (positional source), D20 (qualified capability tokens), D22 (lazy plugin instantiation), D6 (shadow-mode), D7 (no facade), D8 (subpaths + CI bundle test) unless the human overrides; freeze the public types; then build core → hasuraEvent source → plugins (composition model) → platform adapters → migrate `appointment.ready` end-to-end with shadow-mode parity. Verify against the current `hasura-event-detector/src` and `event-handlers` consumers. Respect the §4 correctness guards.
