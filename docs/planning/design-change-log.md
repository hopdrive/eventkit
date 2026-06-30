# EventKit — Design Change Record (v0.2 → v0.3)

**Date:** 2026-06-28
**Author:** Rob Newton (decisions) · Claude (drafting)
**Trigger:** Review of the rewrite showcase surfaced six project-level concerns. These are changes to the **EventKit design and plan**, not just the showcase. Recorded here with rationale; applied to `architecture.md` (bumped to v0.3 draft) and the open-decisions register; reflected in the showcase artifact.

> **Historical change log — covers CHG-1 … CHG-13 only.** This is a *why* record written during design; some
> entries below describe an **intermediate** shape that a later CHG then changed — those spots are marked inline
> with `[Superseded by …]`. The series continues past this file: **CHG-14** (generic plugins built-in / ADR-024),
> **CHG-15** (fully declarative modules / ADR-025), **CHG-16** (full source coverage incl. `webhook`/`hasuraAction`),
> and **CHG-17** (app-`*` → Hasura Action playbook) are recorded in the canonical RFC's revision history. For
> *current* behavior, read the canonical RFC + `design-rationale.md`, not this log.

---

## CHG-1 — Example hygiene: every dependency must show its import
**What:** All code examples (RFC + showcase) must import every symbol they reference. No dependency may appear "magically" — `grafana()` with no import, `sdk` passed into a job from nowhere, etc.
**Why:** Examples are read as authoritative templates. A dep with no visible origin teaches a bad pattern and hides where things come from (and, for `sdk`, hides the module-scope-init shift we actually want to showcase).
**Impact:** Documentation/examples only. No API change.

---

## CHG-2 — Plugins integrate via the lifecycle interface and self-correlate; jobs stay plugin-agnostic
**What:** A plugin must do its work **through the EventKit lifecycle hooks alone**, correlating runtime state from the context IDs it already receives (invocationId, the triggering envelope, jobExecutionId). Jobs and handlers MUST NOT pass plugin-specific objects around to make a plugin work.

Concretely for **Batch**:
- Drop `DurableJobOptions.record`, `batch.record(...)`, `DurableJobContext`, and `ctx.batch.record`.
- `durable` becomes a **declarative boolean flag** on `JobOptions` (`durable?: boolean`), peer to `retries`/`timeoutMs`. **[Superseded by CHG-7 / ADR-015 revised: the `durable` flag was removed entirely — durability is emergent from registering the Batch plugin. There is no `durable` field in shipped core.]**
- The durable job is an **ordinary, batch-unaware job**. It reads its work from `ctx.input` (the handler maps the triggering `batch_jobs` row's `input` column into the job's `input`, which is normal handler→job business data).
- The **Batch plugin** owns all persistence. On `onJobStart`/`onJobEnd`/`onError`/timeout it transitions the triggering `batch_jobs` row (`processing → done / error / timeout`), persists output/logs, and schedules retries — **self-correlating** the row from the invocation's envelope. The job never knows a batch exists.

**Why:** Jobs should be independent and reusable. A job that reads `ctx.batch.record` is coupled to the durability plugin and behaves differently depending on which plugin is loaded — the opposite of independence. The observability plugin already works this way (pure observer of lifecycle); Batch should match. Reading ambient runtime values the framework populates (`ctx.log`, `ctx.signal`, `ctx.trackingToken`) is fine; importing/threading **plugin objects** is not.

**Boundary clarified:** passing *business data the job needs* via `input` (a work unit, a row) = good. Passing *plugin/runtime objects* (a batch record, a token instance) = forbidden.

**Impact:** §12 rewritten; ADR-015 revised; new ADR-017 (general principle); new design principle §3.10. Migration: durable consumers become plain jobs + `durable: true`; no `ctx.batch.record` rewrites.

---

## CHG-3 — Handlers are declarative job lists; conditional job inclusion is forbidden
> **[Superseded in framing by CHG-15 / ADR-025: there is no handler that calls `run()` and no consumer `run()` export. A module is `defineEvent({ name, detector, prepare?, jobs, resolve? })` with a static `jobs` array the runtime runs. The no-conditional-jobs *rule* below still holds — it is now enforced by the branded `JobDefinition` element type, not by a `run(...)` signature.]**

**What:** A handler MUST NOT conditionally add a job to the `run()` array (`cond && job(...)`, ternaries, `if (x) jobs.push(...)`). The `jobs` argument is a strict `JobDefinition[]`. Conditional logic has exactly two sanctioned homes:
1. **Detection** — if whether work runs depends on a condition, that condition defines a distinct business event. Encode it in a detector and give the event its own name.
2. **Inside the job** — input-driven branching that applies to *every* invocation of the job (e.g. "skip if no phone number"), based on `ctx.input`.

Enforcement:
- **Type:** `run(event, jobs: JobDefinition[], options?)` — `cond && job(...)` (a `false | JobDefinition`) is a compile error.
- **Runtime:** `run()` MUST throw loudly on a non-`JobDefinition` entry. (This **reverses** v0.2's "defensively ignore falsy entries" rule, which was wrong — it preserved the anti-pattern.)
- **Lint (recommended):** an ESLint rule flagging `&&`/ternary/`.push` inside a `run([...])` array argument.

**Why:** A conditional job in the handler is a **hidden branch the system cannot see**. It cannot be rendered in the observability/react-flow visualizations and cannot be documented in the expected-flow manifests — defeating two core goals of EventKit. Conditions in the detector (named events) or in the job (input-driven, universal) are both *visible* to tooling. This also codifies long-standing team guidance ([[feedback_event_handler_conditional_in_detector]], [[feedback_event_handler_module_shape]]) that informal review failed to enforce; the new system makes it a compile/runtime error.

**Impact:** §9.5 rule reversed; new ADR-018; new design principle §3.9. Migration: the ~14 existing conditional-job sites must be refactored to named events or input-driven jobs (a real, deliberate migration cost, accepted).

---

## CHG-4 — Showcase uses an established, author-vetted example (not the ARv2 rewrite)
**What:** Replace the `move.pickup.started` example (recent ARv2-rewrite code) with `appointment.ready` (authored 2022-12-30, stable).
**Why:** The `move.pickup.started` handler carries an `eventKey` concept from the recent ARv2 work that sets a key different from the event module's own filename-defined event name — a duplicate, incorrect notion of event identity that should not be held up as exemplary. (Separately flagged to the author.) `appointment.ready` is established, business-clear, and **naturally declarative** (two unconditional jobs — it demonstrates CHG-3 by example), and its detector even documents the Spark-integration insert-as-pending race, tying into the reverse-integration theme.
**Impact:** Showcase examples only. Reinforces the rule that event identity = the module's event name, full stop.

---

## CHG-5 — Developer-friendly registration API
> **[Partially superseded by CHG-10/CHG-11: the source is no longer the `createEventKit({ source: hasura.source() })` object form shown below — it is the first positional arg, `createEventKit(hasuraEvent)`; plugins register as `kit.use(plugin, config?)` (pass the factory, not a call); the adapter is named `hasuraEvent`/`hasuraCron`, not `hasura.source()`. The register-style *direction* below is what shipped.]**

**What:** Replace the single nested `createEventKit({ sources:[...], plugins:[...], events:[...] })` object with a register-style API that mirrors the (well-liked) old `pluginManager.register(...)` ergonomics:

```ts
const kit = createEventKit({ source: hasura.source() });

kit.use(observability({ ... }));
kit.use(batch({ ... }));
kit.use(trackingToken({ extractFromUpdatedBy: true }));
kit.use(grafana());

kit.registerEvents(events);
```

Specific changes:
- `EventKit` gains `use(plugin)` and `registerEvents(modules)` (and `registerEvent(module)`).
- **Single source per kit:** `source` (singular), not `sources: [...]`. (Ratifies open-decision **D14** → *one source per kit*; the plural array was never designed and confused readers.)
- The source is named **`hasura.source()`** — clearly "the Hasura source adapter" — instead of the opaque `hasura()`.
- Validation (duplicate names, missing detector/handler, missing required plugin config/secrets) runs on first `handle()` (or an explicit `kit.validate()`), still fail-fast before any event is processed.

**Why:** The nested-object form was less readable than the code it replaces, and `sources: [hasura()]` did not communicate what it accomplished. Register-style statements read top-to-bottom, match the mental model engineers already have from the old entrypoints, and make each plugin's configuration its own legible line.
**Impact:** §9.7 `EventKit` interface, §18 registration + Netlify handler shape; new ADR-019; open-decision D14 resolved.

---

## CHG-6 — These are project decisions, not artifact tweaks
All of the above are recorded as design decisions and propagated to: the canonical RFC (v0.3 draft), the open-decisions register (D14 resolved; CHG-2/3/5 noted as decided), and the showcase artifact. The design-evaluation and earlier amendment docs are historical and left as-is except where they directly contradict a decision above (noted inline).

---

## CHG-7 — Durability is emergent from plugin registration; remove the core `durable` flag
**What:** Remove `durable` from core `JobOptions` entirely. **Core has no concept of durability.** Instead, the behavior is a pure property of *whether the Batch plugin is registered in the kit*:

- **Registering Batch makes every job in that kit durable automatically** — the equivalent of today's `batchJob(...)` wrapper, applied by virtue of registration, not a per-job flag.
- It is registered **only in the `db-batchjobs` function** (whose source is the `batch_jobs` table); it is never registered in any other kit, so no other function's jobs gain the behavior.
- **Auto input injection.** The plugin injects the triggering `batch_jobs` row's `input` column as the **baseline** `ctx.input`. Handler-supplied `input` is shallow-merged on top (handler keys win — treated as overrides). The handler usually passes only live deps (or nothing); the serializable work payload arrives from the record automatically.
- **Requires the Hasura source.** At its lowest level a batch job is a Hasura DB event on `batch_jobs` with an expected record shape. The plugin declares this dependency; `kit.use()` validates it at init and throws if the source isn't Hasura.
- **Auto-persist** state, output, and logs back to the row via lifecycle hooks (exactly what the wrapper does now): `processing → done / error / timeout`, output, serialized errors.
- **Log flushing is configurable.** End-of-job flush is mandatory; **periodic flushing is optional plugin config** (a flush interval and/or an every-N-entries trigger) to feed the live React view that watches `batch_jobs.output` via an Apollo GraphQL subscription while a background job runs for up to ~15 minutes.

**Why:** A `durable: true` field in core `JobOptions` means core knows batch exists — the precise coupling the plugin model is meant to remove (the smell Rob flagged). Durability must be invisible to core and to jobs: a property of *which plugins are registered*, nothing more. Bonus: the batch-consumer handler loses its last boilerplate — no wrapper, no flag, no input mapping. `run(event, [ job(runApBatch) ])` is the whole handler.

**Mechanism (core stays domain-free):** core gains a generic plugin **context-contribution** step. Before each job runs, registered plugins MAY contribute a baseline `input` (and ambient context fields) which core merges *under* the handler's `options.input`. Batch' contributor reads the triggering envelope (the row) and returns `{ input: row.input }`, and self-correlates the row id for persistence. The same mechanism cleanly homes `trackingToken`'s `ctx.trackingToken`. Core never names batch.

**Impact:** removes `durable` from §9.4; adds `requires` + `augmentJobContext` to the plugin interface (§11); §12 rewritten; ADR-015 revised; ADR-020 added (context contribution / input injection). Supersedes CHG-2's `durable: true` flag with "registration-emergent." Migration gets *simpler* still: batch consumers drop the wrapper, the flag, and the input mapping.

---

## CHG-8 — Runtime portability via a Platform Adapter contract
> **[Superseded by CHG-10: the platform is registered via `kit.use(netlifyPlatform)`, not a `createEventKit({ platform })` param; factories carry the `*Platform` suffix (`netlifyPlatform()`, `lambdaPlatform()`, …). The shipped four are `lambdaPlatform`, `netlifyPlatform`, `netlifyV2Platform`, `netlifyBackgroundPlatform` — all real, none "planned." The PlatformAdapter contract itself is as below.]**

**What:** Deployment-runtime specifics are abstracted behind a **`PlatformAdapter`** registered declaratively on `createEventKit({ platform })` — a sibling extension contract to `SourceAdapter` (what event came in) and `EventKitPlugin` (lifecycle). It implements four methods: `detect?()`, `extractPayload(...args)`, `buildRequest(...args)` (incl. the time-budget closure), `formatResponse(result)`.

- The package ships **`lambda()`** and **`netlify()`**. The contract is open so teams can author `vercel()`, `cloudflare()`, `node()`, etc.
- **The `getRemainingTimeMs` question collapses into three adapter strategies:** (A) native countdown — Lambda/Netlify-classic forward `context.getRemainingTimeInMillis()`; (B) computed deadline from a configured max — Vercel/GCP/Azure/CF/Netlify-v2; (C) none — long-running servers / local. All three surface as the single `RequestContext.getRemainingTimeMs`, so cancellation and flush timing are uniform.
- **Netlify needs multiple adapters.** Its flavors differ in shape: `netlify()` (classic `(event, context)`, `{statusCode,body}`, bucket A), `netlifyV2()` (Web `(Request, Context)` → `Response`, bucket B), `netlifyBackground()` (~15-min budget, returns 202 — the flavor behind the live `batch_jobs` watch view). These are planned as distinct adapters rather than one fuzzy `netlify()`.
- **Entry styles:** `export const handler = kit.handler()` (adapter owns the signature & response) or a thin `kit.handle(event, context)` when a pre-check (auth) must run first. The hand-written `getRemainingTimeMs` closure becomes an escape hatch for custom runtimes/tests only.
- **Detect-and-warn:** the runtime detects the platform from env and warns once at init if a deadline-capable platform is detected but no adapter is registered — turning a silent footgun into a visible nudge.

**Why:** hard-coding `context.getRemainingTimeInMillis()` and `{statusCode,body}` locks the package to Netlify/Lambda and makes the budget wiring a one-line footgun (Rob's concern). An adapter makes runtime portability declarative and is what lets the package legitimately be called *EventKit* rather than a Netlify tool.

**Impact:** §9.7 (`platform` field, `handler()`, platform-args `handle()`); new §9.8 Platform Adapters; §17 contracts list; §18 examples; ADR-021. Showcase: a Platform Adapters section + updated entrypoint.

---

## CHG-9 — Plugin composition model (three hook shapes; default always runs; DI over inheritance)
**What:** A spec for *how* plugins extend the package, so every extension is consistent and composable. Every hook is exactly one of three shapes:
1. **Notification** — `onX`, returns `void`, observe only. `Start`/`End` for phase spans; `Before`/`After` for "a little extra side-effect" around a built-in capability; `onInit`/`onFlush`/`onShutdown` for plugin self-lifecycle.
2. **Delta transform** — bare verb returning a partial the runtime merges over a base: `configureInvocation`, `augmentEnvelope`, `augmentJobContext`. The default always contributes; plugins only add — so "default + extra" is the *only* mode, never replacement.
3. **Singleton capability** — bare verb, exactly one provider (declared via `provides`, uniqueness enforced): `normalize`/`buildDetectorContext`/`buildHandlerContext` (source), `extractPayload`/`buildRequest`/`formatResponse` (platform). The only shape where replacement is possible; to reuse the default, the runtime **injects it as a `base` argument (DI)** — never inheritance/`super`.

Plus: `provides`/`requires` capability declaration (fixing the muddled `requires: { sourceType }`); the **naming rule** `on… = void notification` vs `bare verb = returns a value`; and a new `augmentEnvelope` transform.

**Why:** the old model had one overloaded "before" hook (`onPreConfigure`) that *mutated the payload by reference* and returned option overrides — unpredictable and the opposite of composable. Rob's preference is composability + DI over class inheritance/polymorphism. This model makes "default behavior plus a tiny extra before/after" the native case (notifications + transforms), reserves replacement for singletons, and does replacement by injected-default DI. The naming rule makes a hook's contract legible from its name.

**Naming cleanups it forces:** `onPreConfigure`/`onConfigureInvocation` → `configureInvocation` (returns a value); `initialize`/`flush`/`shutdown` → `onInit`/`onFlush`/`onShutdown`.

**Before → after for the existing plugins:**
- **tracking-token:** `onPreConfigure` (mutates payload + returns options) → `configureInvocation` (delta) + `augmentJobContext` (ambient `ctx.trackingToken`). **Stops mutating the payload** — the biggest correctness win.
- **order-enrichment:** `onPreConfigure` (mutates `hasuraEvent` by reference) → `augmentEnvelope` (delta). Stops mutating.
- **observability:** notifications + `onFlush` (unchanged shape; renamed `flush`).
- **batch:** `augmentJobContext` (inject row input) + `onJobStart/End`/`onJobLog`/`onError` + `onFlush`; `requires: ['source:hasura']`.
- **grafana:** `onLog` + `onJobLog` + `onFlush`; correlation from context, not the `scoped-job` wrapper.
- **sentry/slackAlerts:** `onError` (+ `onFlush`).
- **hasura source / netlify·lambda platform:** expressed as shape-3 capability providers (`provides: ['source']` / `['platform']`).

**Impact:** §11 rewritten (§11.1 model, §11.2 interface, §11.3 before→after table); `onPreConfigure`/`onConfigureInvocation`/`flush`/`shutdown` renamed throughout; ADR-022 added; ADR-012 reinforced (no payload mutation). The unify-vs-sugar registration question (ADR-019/021) is unaffected — this model is the shared backbone either way. Showcase: a composition-model block + per-plugin shape tags + before→after notes.

---

## CHG-10 — `kit.use(plugin, config?)` registration; platform via use(); `*Platform` naming
**What:**
- Plugin registration switches from the factory-call form `kit.use(observability({…}))` to **`kit.use(plugin, config?)`** — you pass the plugin/factory itself (not a call) plus optional config, and **the kit instantiates it**. A bare already-built plugin object is also accepted.
- The **platform adapter moves from a `createEventKit({ platform })` param to `kit.use(netlifyPlatform)`** — it's an optional capability provider like any other plugin. The **required source stays the typed `createEventKit({ source })` param** (compile-time "exactly one, required" guarantee).
- Platform factories renamed with a **`*Platform` suffix**: `netlifyPlatform()`, `lambdaPlatform()`, `netlifyV2Platform()`, `netlifyBackgroundPlatform()`, `vercelPlatform()`, … (the bare `netlify()` read ambiguously).

**Why:** the factory-call form forces an empty `()` on every zero-config plugin and puts instantiation in the caller's hands. `use(plugin, config?)` removes the ceremony and lets the kit own instantiation — so it can inject kit-level context (its logger, the resolved source/platform), validate config, and enforce `provides`/`requires` uniqueness at `onInit`. Moving the platform to `use()` resolves the inconsistency Rob spotted (platform was described as a capability plugin but registered as a special param). Keeping the source as a param preserves the one compile-time guarantee worth keeping.

**The rule:** required singleton (source) → typed `createEventKit` param; optional platform + all observer/transform plugins → `kit.use(plugin, config?)`; event modules → `kit.registerEvents(events)`.

**Impact:** §9.7 (`use(plugin|factory, config?)`, dropped `platform` from config), new §11.4, §9.8 (platform via use()), §18 example; ADR-019 revised; revision history v0.3.4. Showcase: entrypoint, "how they're loaded," all five plugin cards, and the platform section updated. Alternative (source also via `use(hasura.source)`, option B) recorded in ADR-019 as a one-line change if total uniformity is later preferred.

---

## CHG-13 — Detector preferred style: keep the `switch (ctx.operation)` house style
> **[Updated after this entry: the operation-predicate helpers `inserted()/updated()/deleted()/manuallyInvoked()` were *removed* from the detector context. The `switch (ctx.operation)` house style below is exactly right and is now the *only* style; `ctx.operation`, `ctx.columnChanged/columnAdded/columnRemoved`, and `ctx.newRow/oldRow` remain. Ignore the "stays available as sugar" / "already exist" notes below for those four helpers.]**

**What:** The canonical Hasura detector format is the `switch` on operation that the existing modules already use — named boolean facts declared **inside each case branch**, each case's `return` reading like a sentence, and `case 'MANUAL': return false` for console-edit suppression. This replaces the v0.1/early-showcase flat form that collapsed operations into combined booleans (`const becameReady = ctx.updated() && … ; return insertedReady || becameReady`).
**Why:** Rob likes the readability of the per-operation switch from `hasura-event-detector`; turning each operation into a combined variable/`||` chain reads worse. This also matches saved team guidance ([[feedback_event_detector_style]]) — vars inside each case branch (even if duplicated), final return is a sentence, never an inline `columnChanged()` chain. The only EventKit changes vs the current detector are the typed `ctx` API (`ctx.operation`/`ctx.columnChanged`/`ctx.newRow`) and the typed row; `ctx.manuallyInvoked()` stays available as sugar but the `case 'MANUAL'` branch is preferred.
**Impact:** RFC §3.2 (preferred example → switch; discouraged note covers both the flat-combined and inline-chain forms) and §8 (MANUAL note); showcase detector example 01 and the "Console edits" contract-shift row. No API change — `ctx.operation`/`inserted()`/`updated()`/`columnChanged()`/`manuallyInvoked()` all already exist; this is a style/authoring decision.

---

## Net effect on the migration plan
- **Durable consumers** get *simpler*, not harder: delete the `batchJob(...)` wrapper, read `ctx.input`, add `durable: true`. No batch-record threading.
- **Conditional-job sites** get *harder*: ~14 sites need refactoring into named events or input-driven jobs. This is the one place CHG-3 adds migration cost — accepted, because it's the cost of making every branch visible to observability and flow tooling.
- **Entrypoints** get *cleaner*: register-style, single source, one resolved kit at module scope.
