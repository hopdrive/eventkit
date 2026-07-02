# EventKit — Design Rationale (why the final design is what it is)

**Status:** Stable decision record. This is the *why* behind EventKit's shape, distilled from the
pre-build design review, the design evaluation against the legacy system, and the raw planning
conversations. It exists so the decisions below are **not re-litigated** and so the rejected
alternatives are **not mistaken for the current API**.

For *what the system does today*, read the canonical spec — `architecture.md` — and the ADRs it contains. This document only records the reasoning; where a
decision has an ADR, the ADR is the authority. Everything below is stated in current-truth terms:
each subsection pairs the problem that drove a decision with the resolution that shipped.

---

## 1. The problem this rewrite had to solve

EventKit replaces `@hopdrive/hasura-event-detector`, which is consumed at scale: ~245 event modules
under `functions/db-*/events/`, ~40 shared jobs, plus the `scoped-job` wrapper and the Grafana /
Observability / TrackingToken plugins. A pre-build review traced that real consumption surface and
ground-truthed it against the legacy source. Seven consumption realities drove the design — each was
load-bearing in production, and the early RFC drafts under-specified the *seam* to them:

1. **`job(fn, options)` carried business data, not just config.** The legacy second arg was a bag of
   live data handed to the job (`{ sdk, move, role, user, eventKey, getWebhookData }`). It routinely
   held **non-serializable** values — live Apollo/SDK clients and closures.
2. **Some of that data must never be serialized**, yet durability and observability want to persist
   job inputs. Conflating live request data with persisted annotations is exactly the bug that made
   the legacy options-bag incompatible with durability.
3. **Handlers legitimately need source data** — `old` vs `new` rows, `role`, `user`, event time
   (e.g. `sendDriverSilentPushNotification({oldMove, newMove})`, 14 sites). Stripping *detection
   helpers* from the handler is right; stripping *source data* would have been a data-loss bug.
4. **Conditional job inclusion was an idiom**, via short-circuit falsy entries in the jobs array
   (`cond && job(...)`, 14+ sites). A naive typed `JobDefinition[]` would either fail to compile or
   throw at runtime on every non-matching invocation.
5. **`scoped-job` depended on plugins mutating the options object** (`opts.jobExecutionId` injected
   in `onJobStart`, read back to build the log scope and tracking token).
6. **The tracking token is loop-guard infrastructure**, not just a log field — it stamps
   `updated_by` provenance so the system recognizes its *own* DB writes and avoids infinite event
   loops. Mis-homing it produces **event storms** in production with no failing test.
7. **Plugin config was per-invocation** (per-request `invocationId`, per-function client name), but
   the new model binds plugins once at module scope — so there had to be a documented per-request
   entry path and config channel (the role the legacy `onPreConfigure` hook played).

The through-line: the three failures that would have bitten *silently* (no compile error, no failing
test) were the execution-mode default, tracking-token loop prevention, and the handler→job data
channel. The design closes all three explicitly.

---

## 2. Decisions and why (each maps to a shipped resolution)

### Two job data channels — `input` (live) vs `metadata` (persisted) — ADR-011
**Why:** the legacy bag was two things at once. The fix splits them: `input` is request-scoped, live,
**never persisted** (the home for `sdk` clients, closures, `old`/`new` rows); `metadata` is the
serializable, persisted/recorded channel. Reusing `metadata` for everything would crash or silently
corrupt the durable/observability writes — which is the whole point of the rewrite. This split is the
migration vehicle for the ~285 files that used the overloaded bag.

### Handlers/jobs see typed source data, but not detection helpers — ADR-007 (scoped) + source context
**Why:** ADR-007 ("`DetectedEvent` does not carry `DetectorContext`") was correct but over-rotated in
early drafts to "handlers see no source data." The resolution: the source adapter contributes a typed
context extension exposing `operation`/`oldRow`/`newRow` + session-derived `role`/`userId`/`receivedAt`
— **data only, no detection helpers** — so the legitimate need survives without reopening
`columnChanged()` in business logic.

### Fully declarative modules — no handler body, no conditional jobs, no fan-out — ADR-025
**Why:** conditional job inclusion (`cond && job()`) was the idiom that made a typed jobs array unsafe.
Rather than defensively tolerate falsy entries, the design **removes the place to write the condition**:
a module is `defineEvent({ name, detector, prepare?, jobs, resolve? })` with a *static* `jobs` array the
runtime runs — there is no handler function. A condition now lives in the **detector** (it is a distinct
business event) or **inside a job body** (input-driven short-circuit). The branded `JobDefinition`
backstops the one still-expressible mistake. `prepare(ctx)` runs once and is merged into every job's
`input`, replacing the legacy "init the sdk once, thread it into each job" pattern. This supersedes the
earlier "handler returns `JobDefinition[]` / calls `run()`" framing — `run()` is now runtime-internal.

### Execution defaults pinned: parallel + continue-on-failure — ADR-014
**Why:** legacy `run()` is unambiguously `Promise.allSettled` — parallel and fully failure-isolated.
Leaving the default "to be chosen later" was a non-decision in a normative spec. It is pinned to
`mode: 'parallel'`, `continueOnFailure: true`, justified as **migration parity and money-path safety**:
billing jobs (`runAR`/`runARV2`) share an invocation with flaky ones (`publishGenericWebhook`); under a
series/stop-on-failure default a flaky webhook would block billing.

**Update (ADR-031, amends ADR-014, v0.3.18): series is deferred. Parallel is the only mode at launch.** The
`run.mode` (`'series'`) switch and `continueOnFailure` were built, but they're not enabled in the initial
release, and they're removed from the public `RunOptions`/`JobOptions`. Two reasons. The same money-path/parity
logic points the other way here. And there's an abuse concern: series lets a module sequence one job before
another, or feed one into the next. That's exactly the sequential inter-job coupling the declarative model
forbids (ADR-025, no inter-job deps). More risk than value, and no consumer needs it yet. It stays a documented
possible future feature behind the same `run.mode` API, and the `'skipped'` status is reserved for it.

### Loop prevention is a control mechanism, not just an observability field — ADR-016
**Why:** in early drafts the tracking token survived only as something you *log*. It actually *gates
execution*. It is specified as a real loop-guard mechanism (the `source|correlationId|jobId`
codec + a configurable read/write provenance field + a service identity), shipped as the built-in
`loopGuard` plugin. Getting this wrong is silent and catastrophic (event storms), so it is a
first-class, tested control path — not an "app helper to move out."

### Durability is emergent from registering the plugin — no `durable` flag — ADR-015 (revised)
**Why (and what was reversed):** an intermediate design put `durable?: boolean | DurableJobOptions` on
job options, with `batch.record(...)` and a `ctx.batch.record` channel. That was **reversed**:
durability now comes purely from registering the Batch plugin (registered only where needed, e.g.
`db-batchjobs`, `requires` the Hasura source). There is **no `durable` flag, no `batch.record()`,
and no `ctx.batch` object** — the plugin auto-injects the row's `input`, auto-persists, and offers
configurable periodic log flushing. The generic `augmentJobContext` contribution + input-merge
(ADR-020) is the mechanism that replaced the bespoke `ctx.batch` channel.

### Plugin composition model + register-style API — ADR-019, ADR-022
**Why:** per-invocation plugin registration against a global singleton leaked on warm lambdas and gave
no clean per-request config path. The resolution: `createEventKit(source)` runs once at module scope;
`.use(plugin, config?)` registers plugins (kit instantiates them — lazy), `.registerEvents([...])`
registers modules, and `.handler()` owns the per-request `(event, context)` entry and response. The
source is the **first positional arg** (`createEventKit(hasuraEvent)`); the platform is registered via
`.use(netlifyPlatform)`. (Earlier object-wrapper forms — `createEventKit({ sources, plugins, events })`
and `createEventKit({ source })` — were dropped along the way.) Three hook shapes (notification / delta
transform / singleton capability) with `provides`/`requires` capability tokens replace the old
mutate-the-options-object integration model that `scoped-job` relied on.

### One package with subpath exports, not a package family — ADR-024
**Why (reversed twice):** planning first proposed a multi-package family, then a separate
`@hopdrive/app-eventkit` for the HopDrive layer. Both were reversed: the generic-by-config plugins
(loop-guard, observability, `grafana`, sentry, batch) ship **built-in as subpath exports**
of `@hopdrive/eventkit`. They are fully parameterized, so a separate package bought nothing. The
HopDrive layer collapses to config presets + any genuinely SDK-coupled plugin + the app's event modules
(which already live in the consumer repos).

### Detector house style is `switch (ctx.operation)` — operation-predicate helpers removed
**Why (reversed):** an intermediate decision restored `manuallyInvoked()` (and kept
`inserted()/updated()/deleted()`) as detector-context helpers. These were then **removed** in favor of
the team's existing house style: `switch (ctx.operation)` with named booleans per case and
`case 'MANUAL': return false` to suppress Hasura-console edits. MANUAL suppression — which every legacy
module relies on — is preserved by the switch, not by a helper. `columnChanged/columnAdded/columnRemoved`
remain.

### Request/response capability: a module-level `resolve` mapper — ADR-026
**Why:** Hasura Actions (and similar RPC-shaped sources) must return a synchronous value, but EventKit
modules are fire-and-forget job sets. Rather than overload a job's output as the response, a module adds
a single source-agnostic `resolve(ctx) => output`; `jobs` remain optional side effects that run alongside
and are **sibling-ignorant** (`resolve` never reads their results). The response contract
(`resolve` → 2xx; `ClientError(status, …)`/`ActionError(message, code?, …)` → status + `{message,
extensions}`) **composes onto the generic platforms** via `InvocationResult.resolved` — there is **no
dedicated `hasuraActionPlatform`**, which would have forced a `contract × transport` matrix. Two error
classes are kept separate because a status-contract webhook needs an HTTP status (the vendor's retry
contract) while a GraphQL action needs an error `code` the client reads and never sees a status for.

---

## 3. Things that were correct from the start (don't "re-fix" them)

- Source-agnostic `EventEnvelope` → `DetectedEvent` → `JobExecution` vocabulary.
- `DetectedEvent` does **not** carry `DetectorContext` (ADR-007 — the *scoped* version).
- Named-boolean detector readability style — it was already the house style.
- One detector per module; business-semantic event names that describe what happened, not the transport.
- Rejected and kept rejected: a fluent detector DSL; domain helpers inside the source plugin; batch
  jobs modeled as a source adapter.

---

## 4. Provenance

The raw planning conversations live in `raw-conversations/` (ChatGPT transcripts, with source URLs).
The change-by-change record is `design-change-log.md` (CHG-1…13) continued in the
canonical RFC's revision history (CHG-14…17). The open/resolved decision register is
`decision-register.md`. This rationale supersedes and replaces the longer
pre-build analyses (the v0.1 RFC, the A–E amendments, the design review, and the design evaluation),
which have been removed now that their conclusions are folded here and into the canonical RFC.
