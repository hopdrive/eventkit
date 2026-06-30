# EventKit — Open Decisions Register

**Date:** 2026-06-28
**Purpose:** The decisions that must be made by a human before the v0.2 canonical draft (`architecture.md`) can be ratified and drive implementation. Each entry records **what the decision is, where it came from, the options, the blast radius, a recommendation, and what stays blocked until it is answered.**
---

## STATUS AS OF v0.3.14 (canonical RFC) — read this first; this block is authoritative

The framework is now **built**. This status block is the current truth; the per-decision bodies below
are the **original register, kept for provenance** — their `Decision: _____` blanks are historical, not
live prompts. Where a decision has shipped, the code (not a blank line) is the source of truth.

**RESOLVED & IMPLEMENTED (folded into the canonical RFC + `design-rationale.md`):**
- **D1** job data channel → `input` (live) vs `metadata` (persisted). **ADR-011 / CHG-1.**
- **D2** durable model → durability is *emergent from registering the BatchJobs plugin* (no `durable` flag, no `batchJobs.record()`, no `ctx.batch`; plugin injects the row's `input` and self-correlates). **ADR-015 (revised) + ADR-017 + ADR-020 / CHG-2, CHG-7.**
- **D3** `run()` defaults → `mode:'parallel'`, `continueOnFailure:true`. **ADR-014.**
- **D4** per-invocation entry + module-scoped kit (`createEventKit(...).handler()`). **ADR-013.**
- **D5** tracking-token loop prevention → framework seams + built-in `loopPrevention` plugin. **ADR-016 / ADR-024.**
- **D7** compatibility facade → **no facade**; modules are fully declarative (`defineEvent`, no `run()` call), so there is no legacy call shape to wrap. **ADR-025.**
- **D8** package shape → **single package + subpath exports**, shipped. **ADR-024 / CHG-14.**
- **D9** Compare/Console → observability + `graphqlSink` shipped; Console/Compare phased behind (Observed Mode first).
- **D11** async detectors → allowed-but-discouraged; `boolean | Promise<boolean>`, no detection timeout. (a) shipped.
- **D12** observability failure mode → best-effort default (graceful degrade in `graphql-sink`). (a) shipped.
- **D14** one source per kit → **yes**, positional `createEventKit(hasuraEvent)`. **ADR-019 / CHG-5, CHG-10, CHG-11.**
- **D15** `progress()` units → `[0,1]`.
- **D17** MANUAL suppression → **the `manuallyInvoked()` helper was removed**; suppression is `case 'MANUAL': return false` in the `switch (ctx.operation)` house style. (Reversed the v0.2 "restore the helper" decision — see body note.)
- **D18** `EventModule.metadata` optional field set → shipped.
- **D19** registration → positional `createEventKit(source, config?)` + `.use()`. (C) shipped.
- **D20** capability tokens → qualified (`'source:hasura'`). (a) shipped.
- **D21** `netlifyV2Platform` time bucket → built (resolved at impl).
- **D22** plugin instantiation → lazy (kit-owned). (a) shipped.
- **D23** `@hopdrive/app-eventkit` package → **no package**; generic plugins are built-in subpath exports. **ADR-024.**
- **Plus** declarative modules / no conditional jobs (**ADR-025**, supersedes ADR-018); plugins self-correlate (**ADR-017**); `augmentJobContext` (**ADR-020**); platform adapters (**ADR-021**); plugin composition model (**ADR-022**); `webhook`/`hasuraAction` sources + `resolve` request/response (**ADR-026**).

**GENUINELY STILL OPEN — these are process/migration calls with no code yet:**
- **D6** (HIGH) — shadow-mode parity vs straight cutover for money/loop-critical paths.
- **D10** (HIGH) — event-name migration policy (preserve all names vs recorded renames).
- **D13** (MEDIUM) — `metadata` serializability enforcement strictness (runtime check vs types-only).

---

**How to use:** the status block above is current. The bodies below are the original register; read them
for the *why* behind each call. Tiers: **BLOCKING** / **HIGH** / **MEDIUM** / **LOW** / **NEW**.

Provenance shorthand: **v0.1** = the original RFC; **v0.2** = canonical draft (now v0.3.14); the **why**
behind the resolved items is distilled in **`design-rationale.md`**; **CONV** = the raw planning
conversations in `raw-conversations/`; **CODE** = current EventKit source / legacy `event-handlers`.
(The earlier EVAL / REVIEW / amendment A–E docs cited below have been removed; their conclusions live in
`design-rationale.md` and the canonical RFC's ADRs.)

---

## BLOCKING

### D1. Job data channel: confirm `input` (live) vs `metadata` (persisted) is the model
**Question:** Adopt the two-channel `job()` API (ADR-011 / Amendment A) as the migration target for today's options bag?
**Origin:** REVIEW #1/#2 (the options bag carries live `sdk` clients + closures, incompatible with a serialize/persist runtime); CONV proposed plugin-augmented context but never solved per-call business args; A formalized the split. CODE: `move.pickup.started.js` passes `{sdk, getWebhookData, oldMove, newMove}`; `runARV2.js` reads `options`.
**Options:**
- **(a) Two channels** — `input` (by-reference, never persisted) + `metadata` (serializable). *Recommended.*
- (b) Single `metadata` channel + force all job inputs serializable. Breaks every job that takes a live `sdk`/closure; effectively forbids the current idiom.
- (c) Keep an open `[key:string]:any` bag (status quo). Re-introduces the durability/observability serialization hazard the rewrite exists to remove.
**Blast radius:** All ~40 jobs and 245 modules. Determines whether migration is a mechanical port (a) or a per-job redesign (b/c).
**Recommendation:** (a). It is the single change that makes the migration mechanical and type-checked.
**Blocks until answered:** §9.4 type freeze; the entire handler/job migration; the durable contract (D2 builds on it).
**Decision:** _______

---

### D2. Durable execution model: record-backed execution + enqueue-as-side-effect
**Question:** Adopt `durable: batchJobs.record(...)` (consumer) + `batchJobs.enqueue(...)` (producer), with lifecycle driven by §11 hooks and job code no longer calling `batchJob(...)` (ADR-015 / Amendment E)?
**Origin:** EVAL LOST-7 (`DurableJobOptions` referenced but undefined in v0.1); CONV decision "job code MUST stop calling `batchJob(...)`"; CODE: `runARBatchV2.js` is `batchJob({run})` reading `options.batchJob.input`; `runARV2.js` enqueues `ar_v2` rows; `@hopdrive/batchjobs` `BatchJobStatus` enum + `batch_jobs` schema.
**Options:**
- **(a) Record-backed consumer + side-effect producer**, kept separate (matches the real AR enqueue/consume split). *Recommended.*
- (b) Keep the `batchJob(...)` wrapper as-is and only wrap it. Leaves two frameworks (EventKit + batchjobs) instead of collapsing them; the wrapper still owns lifecycle, so plugins can't compose.
- (c) Model batch jobs as their own **source adapter**. Explicitly rejected in CONV — detection is still Hasura on `batch_jobs`.
**Blast radius:** Every durable consumer (AR v2, region pipeline, mature invoices, etc.) and producer. Touches the money path.
**Recommendation:** (a).
**Blocks until answered:** §12 type freeze; phases 6–7 of migration; shadow-mode parity test design.
**Decision:** _______

---

### D3. `run()` default execution mode (money-path behavior)
**Question:** Ratify `mode='parallel'`, `continueOnFailure=true` as the pinned defaults (ADR-014 / Amendment D)?
**Origin:** EVAL LOST-3 (v0.1 left it undefined and *described* series/stop-on-failure); CODE: `handler.ts:59` is `Promise.allSettled` — parallel + fully isolated; the `outcome.resolved` "degraded mode" test asserts the fan-out continues when one fetch fails.
**Options:**
- **(a) parallel + continueOnFailure=true** (matches current runtime exactly). *Recommended.*
- (b) series + stop-on-failure. A flaky `publishGenericWebhook` would block `runAR`/`runARV2` (billing). This is a **silent** regression — no compile error, no test failure unless one exists for that exact ordering.
**Blast radius:** Every `run()` call site (245). This is the highest-risk *silent* behavior change in the whole migration.
**Recommendation:** (a), stated normatively, with series available per-`run()` opt-in.
**Blocks until answered:** §10 semantics; any handler that fans out money + non-money jobs in one `run()`.
**Decision:** _______

---

### D4. Per-invocation entry point + module-scoped runtime
**Question:** Adopt `createEventKit()` once at module scope returning `kit.handle(payload, request)`, with per-request config via `RequestContext`/`InvocationContext` and `onConfigureInvocation` replacing `onPreConfigure` (ADR-013 / Amendment C)?
**Origin:** EVAL LOST-5 / REVIEW #9 (v0.1 stops at `createEventKit`, references `InvocationContext` but never defines it, never shows the per-request call); CODE: `db-moves.js` registers plugins **per invocation** on a global `pluginManager` and calls `listenTo(hasuraEvent, {invocationId, ...})`; `onPreConfigure` exists today (`types.ts:169`).
**Options:**
- **(a) Module-scoped kit + `handle(payload, request)`** — plugins built once; per-request data via `InvocationContext`. Fixes the warm-lambda re-registration leak. *Recommended.*
- (b) Keep per-invocation plugin registration. Preserves the leak and gives EventKit no clean per-request config channel.
**Blast radius:** Every `db-*` entrypoint (the function Netlify actually invokes). Defines the public runtime surface.
**Recommendation:** (a).
**Blocks until answered:** §9.7 type freeze; entrypoint rewrite; how Observability/Grafana receive `invocationId`/`sourceFunction`.
**Decision:** _______

---

### D5. Tracking-token loop prevention: where the mechanism lives
**Question:** Is the loop-prevention contract (inbound provenance from `updated_by` → `envelope.meta.sourceTrackingToken`; outbound deterministic `ctx.trackingToken` stamped into writes) part of the **framework spec** (hook points generic, `updated_by`/token-format app-specific), per ADR-016?
**Origin:** EVAL LOST-2 (v0.1 carried tracking token only as an observability *field*, not a control mechanism); CODE: `TrackingTokenExtractionPlugin` + `TrackingToken.forJob` + `scoped-job.js`; §3.3 says HopDrive helpers move to app packages.
**Sub-decision:** What is generic vs app-specific?
- **Generic (in EventKit):** the extraction hook point (`onConfigureInvocation`/`onInvocationStart`), `envelope.meta.sourceTrackingToken`, and the `ctx.trackingToken` surface.
- **App-specific (in a HopDrive plugin):** the `updated_by` column convention and the token *format/derivation*.
**Options:**
- **(a) Split as above** — framework provides the seams, HopDrive plugin provides the `updated_by` semantics. *Recommended.*
- (b) Put the whole thing in core. Violates §3.3 (HopDrive-specific) and couples core to a column convention.
- (c) Leave it entirely app-side (v0.1 stance). Then the framework gives no seam to hang it on and re-homing is ad hoc — the highest risk of a production event storm.
**Blast radius:** Correctness-critical. A mistake here is **event storms in production**, not a failing test.
**Recommendation:** (a), and shadow-mode test it before cutover (see D6).
**Blocks until answered:** §13 loop-prevention contract; the tracking-token plugin design; phase 4 of migration.
**Decision:** _______

---

## HIGH

### D6. Cutover strategy for money/loop-critical paths: shadow-mode parity vs straight cutover
**Question:** Require running EventKit alongside the current runtime and diffing outputs for AR/tracking-token/billing paths before switching them over (v0.2 §19.7)?
**Origin:** EVAL recommendation; the AR/tracking-token paths fail silently (no test catches a storm or a blocked-billing fan-out).
**Options:**
- **(a) Shadow-mode parity** for the critical paths; straight per-module cutover for the rest. *Recommended.*
- (b) Straight cutover everywhere. Faster; bets the money path on unit tests that don't cover the silent failure modes.
**Blast radius:** Migration timeline + confidence. Adds engineering to build the shadow harness; buys safety on the only paths where a bug costs money.
**Recommendation:** (a).
**Blocks until answered:** Migration plan sign-off; whether to build a shadow harness at all.
**Decision:** _______

---

### D7. Compatibility facade: build it, or migrate per-module?
**Question:** Build a facade that re-exposes `run(eventName, hasuraEvent, jobs)` / `job(fn, dataBag)` over EventKit, or skip it and migrate modules directly?
**Origin:** v0.1 §19 listed the facade as an early, easy phase; EVAL/REVIEW argue it is the **single hardest** component (it must reimplement the old runtime + synthesize envelopes/JobContext) and still won't fix tests that import internals.
**Options:**
- **(a) No facade; per-module migration** + shadow mode for critical paths. *Recommended* — avoids building a throwaway runtime.
- (b) Build the facade. Lets unmigrated modules keep importing the old name, but is high-effort, throwaway, and leaky (tests, `scoped-job`, tracking token all bypass it).
- (c) Thin facade for *imports only* (re-export new symbols under old names) without re-creating old call shapes. Low value since the call shapes are exactly what changed.
**Blast radius:** Determines whether a large throwaway component gets built. Affects how "incremental" the migration really is.
**Recommendation:** (a).
**Blocks until answered:** Phase 1–2 of migration; effort estimate.
**Decision:** _______

---

### D8. Package shape: single package + subpath exports vs package family
**Question:** Ship `@hopdrive/eventkit` with deep subpath exports (`/sources/hasura`, `/plugins/batchjobs`), or the `@hopdrive/eventkit-*` package family CONV settled on?
**Origin:** v0.1 reversed CONV's package-family decision to subpaths **without recording the trade-off**; REVIEW/EVAL flagged the Netlify esbuild/zisi "works locally, module-not-found at deploy" risk; v0.2 §17 gates it on a CI bundle smoke test.
**Options:**
- **(a) Subpaths, gated on a Netlify-bundle smoke test** in CI; family is the fallback if bundling proves unreliable. *Recommended* — defer the bet to evidence.
- (b) Commit to subpaths now. Cleaner scope; risks deploy-time resolution failures under the repo's `hopdrive-inline` step.
- (c) Package family. Independent versioning per adapter/plugin; more release overhead; the operational burden v0.1 wanted to avoid.
**Blast radius:** Deploy reliability across all `db-*` functions; release process.
**Recommendation:** (a).
**Blocks until answered:** Package layout; CI design; can't finalize import examples in the RFC until chosen.
**Decision:** _______

---

### D9. Compare Mode / Flow Manifests / Console: scope and sequencing for v1
**Question:** Are Flow Manifests, Compare Mode, and the Console **in scope for the first EventKit release**, or explicitly phased behind a proven runtime migration (v0.2 §14 caveat)?
**Origin:** CONV (observability thread) treated the matcher as a **hypothesis to validate on one flow first**; v0.1 presents the full matcher/classifications as settled and never specifies the Console **backend host/API**. EVAL flagged risk of building speculative tooling ahead of the migration.
**Options:**
- **(a) Phase behind the runtime; ship Observed Mode first; prove Compare on one flow** (mobile-service-dispatch) before generalizing. *Recommended.*
- (b) Build Compare Mode + manifests as a co-equal v1 goal. Risks investing in a matcher before the data model it depends on is stable.
- (c) Drop manifests/Compare from EventKit scope entirely for now; keep only observability records.
**Sub-decision:** Is the Console backend (host, auth, query layer over observability storage) in scope at all for v1? v0.1 lists `GET /flows/:flowId` etc. with no backend.
**Blast radius:** A large chunk of optional scope and timeline.
**Recommendation:** (a); Console backend out of v1 except a read API over existing observability storage.
**Blocks until answered:** Roadmap; how much of §§14–16 is normative now vs aspirational.
**Decision:** _______

---

### D10. Event-name migration policy: preserve all existing names, or allow recorded renames?
**Question:** Must the migration preserve **every** existing event name (including non-ideal ones like `move.pickedup`), or may it rename with an aliasing/backfill plan?
**Origin:** EVAL LOST-10; CONV notes names like `move.pickedup` already exist; v0.2 §8 mandates stability and forbids opportunistic tidying. Renames break observability history, Flow Manifests, tests, downstream consumers keyed on the name.
**Options:**
- **(a) Preserve all names verbatim during migration**; any rename is a separate, deliberate, recorded change with an alias/backfill. *Recommended.*
- (b) Allow tidying during migration. Cleaner names; orphans historical observability data and risks downstream breakage.
**Blast radius:** Observability continuity; any consumer that keys on event name.
**Recommendation:** (a).
**Sub-decision:** For genuinely bad existing names, do we carry the debt indefinitely or schedule a post-migration rename wave with aliasing? (Recommend: carry now, schedule later.)
**Blocks until answered:** Per-module migration checklist.
**Decision:** _______

---

## MEDIUM

### D11. Async detectors: allow-but-discourage, or forbid / time-box?
**Question:** Detectors are typed `boolean | Promise<boolean>`. Permit async (DB-touching) detectors, discourage them, or forbid/time-box detection?
**Origin:** CONV risk note; every detector runs for every invocation across all registered modules, so async detection is a scale/reliability multiplier.
**Options:**
- **(a) Allow but strongly discourage**; detectors SHOULD be pure over the context; revisit a detection-phase timeout later. *Recommended.*
- (b) Forbid async detectors (sync-only signature). Simplest/safest; may block a legitimate future need.
- (c) Allow + impose a detection-phase timeout now. More runtime complexity before a concrete need.
**Blast radius:** Detector authoring guidance; runtime complexity.
**Recommendation:** (a).
**Decision:** _______

---

### D12. Observability failure mode: best-effort default + strict opt-in
**Question:** Ratify that observability/durability **write** failures do not fail business execution by default, with a strict opt-in?
**Origin:** EVAL (v0.1 said "should usually not prevent… unless strict" — not normative enough); §13/§11.
**Options:**
- **(a) Best-effort default, strict opt-in**, with per-plugin documentation of which hooks are fatal. *Recommended.*
- (b) Strict default. An observability outage would take down business execution — unacceptable for logistics.
**Blast radius:** Production resilience.
**Recommendation:** (a).
**Sub-decision:** Flush-on-timeout guarantee level — confirm "best-effort, durable jobs recover from `batch_jobs` state, not observability" (v0.2 §13).
**Decision:** _______

---

### D13. `metadata` serializability enforcement: where and how strict?
**Question:** How is "`metadata` must be serializable" enforced — fail-fast at `job()` registration, at runtime before persist, or types-only?
**Origin:** A/E normative line; static detection of non-serializable values (functions, class instances) is limited in TS.
**Options:**
- **(a) Runtime check before the first persist of a `durable` job** (throw with a clear message naming the offending key). *Recommended* — catches the real hazard cheaply.
- (b) Best-effort at `job()` registration. Earlier, but can't see runtime values reliably.
- (c) Types only (`Record<string, unknown>` documented as serializable). Cheapest; relies on discipline; the corruption mode survives.
**Blast radius:** Durable-job authoring ergonomics; how loudly the system fails on a misplaced `sdk` in `metadata`.
**Recommendation:** (a).
**Decision:** _______

---

### D14. One source per kit, or multi-source routing?
**Question:** `createEventKit({ sources: [...] })` is plural. Does a kit handle exactly one source per process (per Netlify function), or route a payload across multiple registered sources?
**Origin:** CONV used `source:` (singular, `createEventRuntime`); v0.1/v0.2 use `sources: [...]` (plural) — the plural was **never discussed**; routing semantics (which adapter claims a payload, conflicts) are unspecified.
**Options:**
- **(a) One active source per kit** (plural array kept for config symmetry but a function registers the one it serves). Matches the current one-table-per-`db-*`-function reality. *Recommended.*
- (b) Multi-source routing in one kit. Needs a claim/dispatch rule (by sourceType? by payload shape?) and conflict handling — real complexity for no current use case.
**Blast radius:** Runtime routing logic; entrypoint shape.
**Recommendation:** (a); revisit (b) only when a concrete multi-source-per-function case exists.
**Decision:** ✅ **RESOLVED — (a) one source per kit.** Final API is positional: `createEventKit(hasuraEvent)` (the source is the first arg; the early `{ source: ... }` object form was dropped). See `design-change-log.md` CHG-5/10/11 / ADR-019.

---

## LOW (safe to default; confirm only if you disagree)

### D15. `progress(value)` units
`[0,1]` fraction (v0.2) vs `0–100`. Origin: legacy batch system never standardized it. **Recommendation:** `[0,1]`. **Decision:** _______

### D16. Factory/naming ratification
`createEventKit` (vs CONV's `createEventRuntime`); `hasura.detector` / `hasura.handler`; package scope `@hopdrive/eventkit`. Origin: CONV used `createEventRuntime`; everything else consistent. **Recommendation:** keep v0.2 names. **Decision:** _______

### D17. MANUAL suppression behavior
**Decision:** ✅ **RESOLVED — the `manuallyInvoked()` helper was removed** (along with `inserted()/updated()/deleted()`). MANUAL suppression stays explicit and per-module, expressed directly in the house style: `switch (ctx.operation) { … case 'MANUAL': return false }`. This reverses the v0.2 "restore the helper" recommendation — the operation-predicate helpers added surface area the `switch (ctx.operation)` style already covers. The framework does **not** suppress MANUAL globally; each detector decides.

### D18. `EventModule.metadata` fields
Confirm the optional set: `description, tags, owner, flowHints, deprecated, relatedDocs` (v0.2 §18). **Recommendation:** ship the set as optional; nothing depends on it at runtime. **Decision:** _______

---

## NEW — decisions surfaced after the original register (still open)

### D19. Registration uniformity: positional source (C) vs everything-via-`use()` (B)
**Question:** Keep the required source as `createEventKit(hasura)` (positional first arg — **option C, current**), or also route the source through `kit.use(hasura)` with `createEventKit()` taking nothing (**option B, total uniformity**)?
**Origin:** ADR-019 (recorded alternative); evolved across CHG-5/10/11.
**Options:**
- **(C, current/recommended)** `createEventKit(source, config?)` positional; everything else `kit.use(plugin, config?)`. Keeps a **compile-time guarantee** that exactly one source is present.
- (B) `createEventKit()` empty; `kit.use(hasura)` registers the source like any plugin. Maximal uniformity (one verb), but "source present + exactly one" downgrades to a **runtime `validate()` check**.
**Blast radius:** Entrypoint ergonomics only; one-line change either way.
**Recommendation:** C — the one place a required positional arg earns its keep.
**Decision:** _______

### D20. `provides`/`requires` capability granularity
**Question:** Are capability tokens role-level (`'source'`, `'platform'`) or qualified (`'source:hasura'`)? BatchJobs must depend on **Hasura specifically** (it reads the `batch_jobs` row shape), not "any source."
**Origin:** §11.1/§11.4 + §12 (`requires: ['source:hasura']` appears); flagged earlier.
**Options:**
- **(a, recommended)** Qualified tokens: role + optional qualifier (`'source'`, `'source:hasura'`, `'platform'`). Uniqueness enforced at the role level; `requires` may pin a qualifier.
- (b) Role-level only — simpler, but can't express "requires Hasura specifically."
**Blast radius:** Plugin `provides`/`requires` typing + the init-time validation.
**Recommendation:** (a).
**Decision:** _______

### D21. `netlifyV2Platform()` time-budget bucket
**Question:** Is Netlify v2 (`(Request, Context)`) **bucket A** (the v2 context exposes a live countdown) or **bucket B** (computed deadline from a configured max)?
**Origin:** §9.8 (marked "treated as B unless v2 confirms a countdown").
**Resolution path:** Verify the v2 `Context` shape at implementation; default to **B** (safe) until confirmed.
**Blast radius:** Cancellation/flush precision for the reverse-integration repos only.
**Decision:** _______ (verify at impl)

### D22. Plugin instantiation timing under `kit.use(plugin, config?)`
**Question:** When the kit instantiates a factory passed to `use()`, is it **eager** (at the `use()` call) or **lazy** (at `validate()`/first `handle()`)?
**Origin:** §11.4 (the kit "owns instantiation" — timing unspecified).
**Options:**
- **(a, recommended)** Lazy at `validate()`/first `handle()` — so the kit can inject kit-level context (resolved source/platform, logger) into construction and run `requires`/`provides` checks once everything is registered.
- (b) Eager at `use()` — simpler, but kit-level context (e.g. the resolved platform) may not exist yet when an earlier `use()` runs.
**Blast radius:** Plugin authoring (what's available at construction); when config/`requires` errors surface.
**Recommendation:** (a).
**Decision:** _______

---

### D23. Does the HopDrive layer warrant a published `@hopdrive/app-eventkit` package? [added v0.3.8]
**Question:** After ADR-024 moved the generic-by-config plugins (loop-prevention/tracking-token, grafanaLogger, sentry) into core as built-in subpath exports, what remains HopDrive-specific is (a) config presets that pin the shared token format / `updated_by` field / service id so all repos stay mutually intelligible, (b) any genuinely SDK-coupled (`@hopdrive/sdk-*`) enrichment plugin, (c) the app's event modules. Does (a)+(b) justify a separately-published `@hopdrive/app-eventkit` package, or should the presets just live as a shared config object/file in the consumer repos?
**Origin:** ADR-024 (v0.3.8) — the generic-vs-app boundary was redrawn; the package question is the leftover.
**Options:**
- **(a, recommended)** No package unless/until a real SDK-coupled plugin exists — ship the config presets as a small shared config object in the consumer repos (or a tiny internal module). Avoids a published package whose only content is a few literals.
- (b) Publish `@hopdrive/app-eventkit` now, housing the presets so every repo imports one source of truth for the token format / field / service id.
**Blast radius:** Where consumers import their loop-prevention/transport config from; one more package to version + release if (b).
**Recommendation:** (a) — defer the package; revisit if a SDK-coupled enrichment plugin materializes. Not a Phase-0/1 gate; only matters at Phase 3 (plugins) / Phase 6 (first migration wiring).
**Decision:** _______

---

### D24. Package version & repo strategy vs the predecessor [added 2026-06-30]
**Question:** What initial `@hopdrive/eventkit` version should ship, and should EventKit replace the code in the `hasura-event-detector` repo (then rename the repo) or live in its own brand-new repo?
**Origin:** EventKit is a new package name succeeding `@hopdrive/hasura-event-detector` (latest published `2.3.6`). The migration is gradual (~245 modules), so both packages run in production simultaneously for months.
**Decision:** ✅ **RESOLVED 2026-06-30.**
- **Version → start `0.1.0`, cut `1.0.0` at the first live prod migration (API freeze).** *Not* `3.0.0`: version numbers don't carry across package names, a `3.0.0` start leaves a confusing 1.x/2.x gap on a brand-new package and overstates maturity (still unpublished, open migration calls D6/D10/D13). Lineage is recorded in docs (the README "successor" note + `design-rationale.md`), not the version integer.
- **Repo → keep EventKit as its own brand-new repo; do NOT replace-and-rename `hasura-event-detector`.** Reasons: (1) the predecessor must stay independently patchable during the long migration — overwriting its repo removes the home for a `hasura-event-detector@2.3.x` bugfix; (2) the two packages version independently while both are live in prod — one non-monorepo repo can't do that cleanly; (3) the renamed repo's history would be the old codebase + one wholesale replacement commit (the clean eventkit history is worth more); (4) a repo rename still breaks Netlify/CI/deploy references that GitHub redirects don't cover.
- **End-state:** when the last consumer is migrated, `npm deprecate @hopdrive/hasura-event-detector "use @hopdrive/eventkit"` and archive the old repo. A standalone clean package is also trivial to absorb into the eventual monorepo.
**Blast radius:** Release/versioning story; migration ops; the eventual monorepo move.

---

### D25. Unify sources & platforms as plugins; reorganize code under `src/plugins/` [added 2026-06-30]
**Question:** Sources and platforms are already "singleton capability providers" in the composition model (ADR-022). Should the code and docs treat them as *plugins* — each in its own folder under `src/plugins/`, self-declaring `name`/`provides`/`requires` — and how far should the type unification go?
**Origin:** Code-organization smell: observer/transform plugins each get their own folder under `src/plugins/`, but sources live under `src/sources/*` and all four platforms are crammed into a single `src/platforms/index.ts`. The model says they're plugins; the tree doesn't show it.
**Decision:** ✅ **RESOLVED 2026-06-30 (ADR-027).**
- **Model → one `plugin` concept, three kinds** by capability provided: source (`'source'`, required singleton), platform (`'platform'`, optional singleton), observer/transform (zero-or-more). All declare `name`/`provides`/`requires`.
- **Type contracts → keep the three interfaces** (`SourceAdapter`/`PlatformAdapter`/`EventKitPlugin`); do **not** collapse into one discriminated union (deferred — more churn than gain now; revisit if they drift).
- **Registration → unchanged.** Source stays the typed positional arg `createEventKit(hasuraEvent)` (preserves the compile-time exactly-one-source guarantee, D19); platform + others via `kit.use(plugin, config?)`.
- **Code org → a FLAT `src/plugins/`**: every plugin its own folder **directly** under `plugins/` with **no subcategory folders**. Naming: **`<type>-<name>`, dash-case, type-first, and the folder name === the plugin `name` property exactly** (not just similar). Sources `source-hasura-event`/`-cron`/`-action` (each Hasura adapter split into its own plugin; shared parsing/types in a non-plugin `hasura-shared/`) + `source-webhook`; platforms `platform-lambda`/`-netlify`/`-netlify-v2`/`-netlify-background`; the observer/transform plugins are unprefixed (`observability`, `batchjobs`, `loop-prevention`, `grafana`, `sentry`). Support files: `hasura-shared/`, `platform-shared.ts`, and barrels `source-hasura.ts`/`platforms.ts`. Factory exports stay camelCase (`hasuraEvent`, `netlifyPlatform`). **Public subpaths stay short & unchanged** (`./sources/hasura`, `./platforms`, `./plugins/transports/grafana`) via the `exports` map.
- **`name` vs recorded source:** the plugin `name` (= folder) is registration identity; the recorded source (`envelope.source` / observability `source_system`) is taken from the normalized envelope (`'hasura'`, `'webhook:stripe'`), so renaming plugins did **not** change observability data. (Casing: dash-case chosen over camelCase — filesystem-safe macOS↔Linux, matches npm/subpath/capability-token conventions.)
- **Status:** ✅ **implemented & verified** — typecheck + contracts + 106 unit tests pass; build + bundle smoke resolve all 12 subpaths (ESM+CJS); e2e through the live `netlify dev` (:8888) on the consumer proofs (action-ping success/ActionError, db-chaos UPDATE, cron) all green. No consumer import changed.
**Blast radius:** Internal source tree, the `exports` map + bundle smoke test, internal imports, and the local consumer proofs (their short import paths are unaffected).

## Decision dependency map (what unblocks what)

```
D1 (input/metadata) ──► D2 (durable) ──► D6 (shadow mode) ──► cutover
        │                   │
        └──► D13 (serializability enforcement)
D3 (run defaults) ─────────────────────► cutover (money path)
D4 (entry point) ──► D5 (loop prevention) ──► D6 ──► cutover
D8 (package shape) ──► CI bundle gate ──► phase 1
D7 (facade?) ──► phase 1–2 scope
D9 (compare/console scope) ──► roadmap (independent of runtime cutover)
D10 (name policy) ──► per-module migration checklist
D14 (source routing) ──► entrypoint shape
```

**Minimum set to start implementation correctly:** D1–D5 are **RESOLVED** (see status block at top). The remaining gating items are **D6–D8** (settle before the first critical-path module migrates) and **D19/D20/D22** (settle before freezing the plugin/registration types). D9–D13, D15–D18, D21 can default/verify-at-impl if unanswered.
