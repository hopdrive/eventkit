# EventKit RFC — Design Evaluation Against Current System + Planning History

**Date:** 2026-06-28
**Inputs:** `EventKit Architecture RFC.md`, `EventKit-design-review-202606281600.md`, the current `hasura-event-detector` source (`src/handler.ts`, `src/types.ts`, `src/plugin.ts`, `package.json`), and the four raw planning conversations in `raw-conversations/`.
**Question asked:** Does the RFC, as written, (a) lose concepts that were established during planning, (b) reintroduce the failure modes the design review already called out, and (c) risk turning a *stable* system into a source of bugs?

**Bottom line:** The RFC is conceptually strong and the *strategic* framing survived intact. But the design review's findings are real — I ground-truthed them against the actual source and they hold. On top of that, the conversation history shows the RFC **lost or under-specified several concepts that were explicitly worked out during planning**, and in two cases the RFC dropped a solution the team had already designed. The riskiest gaps are not the porting cost — they are three *silent* correctness regressions: execution-mode default, loop-prevention/tracking-token, and the handler→job data channel. None of these fail a unit test; all three fail in production.

A recurring meta-finding: the consolidation conversation records that the RFC chapters were "intentionally concise because of generation limits." Several gaps below are therefore likely **compression artifacts** (the design existed, it just didn't make it into the export) rather than genuine design reversals. That is good news — the raw conversations are the recovery source. But until the RFC is re-expanded, an implementer reading *only the RFC* will build the wrong thing.

---

## Part 1 — Design-review findings, validated against current source

I confirmed the review's load-bearing claims directly in `src/`. They are accurate.

| Review claim | Ground truth in source | Verdict |
|---|---|---|
| `job(fn, options)` — `options` is **both** config and the business-data bag handed to the job | `handler.ts:142` calls `func(event, hasuraEvent, enhancedOptions)`; `JobOptions` has `[key: string]: any` (`types.ts:105`) | **Confirmed.** EventKit's `JobOptions` (closed shape: name/timeoutMs/retries/tags/metadata/durable/continueOnFailure) has nowhere to put `{sdk, move, role, user, getWebhookData}`. |
| `run()` is fully parallel + failure-isolated | `handler.ts:59` `Promise.allSettled(safeJobs)`; every job pushed unconditionally | **Confirmed.** Current behavior = `mode: 'parallel'` + `continueOnFailure: true`. The RFC's described series/stop-on-failure semantics are the **opposite**. |
| Falsy/conditional job entries are tolerated | `handler.ts:50-52` destructures then `if (!func) continue` | **Confirmed.** `jobs: JobDefinition[]` won't compile against `cond && job(...)` and will throw at runtime unless `run()` defensively filters. |
| Plugins mutate the options object to inject `jobExecutionId` | `handler.ts:110-111` comment + `callOnJobStart(output.name, enhancedOptions, …)` | **Confirmed.** This is the exact mechanism `scoped-job` depends on and RFC §11 designs out. |
| `onLog` captures framework-internal logs at all levels (incl. timeouts) | `types.ts:224-230` `onLog(level, message, data, jobName, correlationId)` | **Confirmed.** EventKit only exposes `onJobLog` (job scope). Detector/runtime/timeout logs lose their Grafana hook. |
| Handlers/detectors receive the raw event and re-derive role/user/old/new | `types.ts:291-297` detector & handler are `(event, hasuraEvent)`; consumers call `parseHasuraEvent` | **Confirmed.** EventKit's `HandlerContext` (§9) has no Hasura fields at all. |

**One thing the review *over*-stated, worth correcting:** there is an existing `onPreConfigure` plugin hook (`types.ts:169`) that lets a plugin rewrite `ListenToOptions` *before* invocation. That is a real per-invocation config channel in the current system, and it has **no analog** in EventKit's `EventKitPlugin`. So the per-request-config problem (review item #9) is slightly worse than stated: the current system has a sanctioned hook for it that the RFC removes.

**Net on Part 1:** every consumption failure mode in the design review is real and reproducible from source. I have nothing to retract from it.

---

## Part 2 — Concepts LOST or distorted between the planning conversations and the RFC

This is the part the design review couldn't see, because it only read the RFC + the consumer repo. Cross-referencing the four raw conversations against the RFC surfaces the following. Items are ranked by production risk.

### LOST-1 (CRITICAL): The handler→job data channel had a *direction* in planning; the RFC dropped it to a vague "plugins MAY augment"
The framework-redesign chat explicitly killed the old `options`-bag pattern **and proposed the replacement**: plugin-augmented `JobContext` fields — `ctx.batch.record`, `ctx.trackingToken`, `ctx.hasura` — contributed by plugins so job authors stop writing wrappers (redesign chat ~1789-2013). The RFC kept the *deletion* ("plugins MAY augment contexts", §11) but **never specified the augmentation contract**: no extension interface, no `ctx.batch` shape, no registration mechanism.

Worse, even the planned mechanism only ever addressed *cross-cutting plugin data* (batch record, tracking token). It never addressed **per-call business arguments** — `{move, role, user, sdk, eventKey}` that today's handlers compute once and hand to each job. That is the actual blocker for 245 modules / ~40 jobs, and it is unsolved in *both* the conversation and the RFC. The cleanest fix (a typed, non-persisted `input`/`deps` field on `job()`, distinct from the serialized `metadata`) appears nowhere. **This is the migration.**

### LOST-2 (CRITICAL): Loop-prevention / tracking-token survives only as an observability *field*, not as a *control mechanism*
The tracking token is how the system recognizes its **own** DB writes and avoids infinite event loops (`db-moves.js`, `scoped-job.js`, `TrackingTokenExtractionPlugin`). The observability chat described threading it (and `source_job_id`) to stitch invocation chains. In the RFC it appears **only** in Observability record lists (RFC lines 633/637) — i.e. as something you *log*, not something that *gates execution*. There is no spec for: how the Hasura adapter inspects `updated_by` provenance before invoking the runtime, how a job stamps its writes, or where the suppression decision lives now that it's "an app helper to move out" (§3.3). Failure mode if mis-homed: **production event storms**, silent, not caught by any test. The RFC underweights this to a generic "move helpers to app packages" line.

### LOST-3 (CRITICAL): The execution-mode default was never locked — and the RFC's described default would regress the money path
Two conversations confirm `run()`'s default mode was **never decided** in planning; it was carried into the RFC's `RunOptions` without a pinned value. The current system is unambiguously parallel + isolated (`Promise.allSettled`). RFC §10 describes series with `continueOnFailure:false` stopping subsequent jobs. If that becomes the default, a flaky `publishGenericWebhook` can block `runAR`/`runARV2` (billing). The `outcome.resolved` "degraded mode" test already asserts the fanout *continues* on a failed fetch. **Pin `mode:'parallel'`, `continueOnFailure:true` normatively, justified as migration-parity** — the RFC currently calls this "choose to preserve current behavior," which is a non-decision in a normative spec.

### LOST-4 (HIGH): `HasuraHandlerContext` — the team designed the fix for ADR-007's over-rotation, then dropped it
ADR-007 ("DetectedEvent does not carry DetectorContext") is correct and was correctly captured. But the redesign chat went one step further and **defined the safe escape hatch**:

```ts
export interface HasuraHandlerContext<TNewRow, TOldRow = TNewRow>
  extends HandlerContext<HasuraEventPayload<TNewRow>> {
  operation: HasuraOperation;
  oldRow: TOldRow | null;
  newRow: TNewRow | null;
}
```

The RFC's `HandlerContext` (§9) has **no Hasura fields and no `HasuraHandlerContext`**. So a handler needing `old` vs `new` (e.g. `sendDriverSilentPushNotification({oldMove, newMove})`, 14 sites) has no typed path — it must cast `envelope.payload` by hand, and the shape of `envelope.payload` for Hasura is itself unspecified. The conversation *solved* this; the RFC *lost the solution*. This converts review item #4 from "porting cost" to "a designed fix was deleted."

### LOST-5 (HIGH): The per-invocation entry point (`runtime.handle(payload, requestContext)`) and `InvocationContext`
Planning explicitly named the function that replaces `listenTo()`: `runtime.handle(rawPayload, requestContext)`, where `requestContext` carries invocationId / correlation / client-name. The RFC stops at `createEventKit({...})`, references `InvocationContext` in a plugin hook signature (RFC line 568) **but never defines it**, and never shows the per-request call a Netlify handler actually makes. Combined with the removal of `onPreConfigure` (Part 1), there is currently **no documented way to inject per-invocation config into module-scoped plugins**. This is a hole in the public API, not a detail.

### LOST-6 (MED-HIGH): `manuallyInvoked()` / MANUAL suppression
Planning included a `manuallyInvoked()` Hasura helper. The RFC documents only `inserted()/updated()/deleted()` (§8); MANUAL survives only as a source *category* and a test-case suggestion. Today **every** module does `case 'MANUAL': return false` to suppress Hasura-console edits. If MANUAL collapses into `updated()`, console edits begin firing events that are deliberately suppressed today — a behavioral change, not just a missing helper.

### LOST-7 (MED, implementation-blocking): A cluster of referenced-but-undefined types
The RFC names these and never defines them — each was at least partially specified in planning:
- `DurableJobOptions` and what `batchJobs.record(ctx.newRow)` returns (the handler↔batch-plugin contract).
- `SerializedError` — planning decided `serializeError()` / `serializeOutput()` / `replaceCircularReferences()` should move **into core** (batch jobs already do circular-ref handling before persist). RFC references `SerializedError` with no shape and no utilities.
- `JobProgress` / `JobCheckpoint` — what `progress(value)` accepts (0-100? float?), what `checkpoint()` persists to, who owns it.
- `JobLogger` / `HandlerLogger` / `DetectorLogger` — planning established a **tiering** (detectors get `debug` only; jobs get `info/warn/error`). RFC drops the tiering and the interfaces.
- `InvocationContext` / `ErrorContext` — used in hook signatures, never defined.

These don't fail in production; they fail at "start implementing," because the extension contracts plugin/job authors depend on don't exist yet.

### LOST-8 (MED): Synchronous observability on the hot path + `flush()` timing in serverless
The current ObservabilityPlugin uses `transport:'graphql'`. RFC §11 says plugins *SHOULD* buffer; §13 (the section an implementer actually reads to build it) never makes buffer-and-flush **normative** for observability. Result: a naive implementation does a GraphQL round-trip per job-start/job-end × 245 functions → 200-400ms added to every invocation. Separately, the batch plugin's `flush()` is meant to persist partial state before a serverless timeout, but **Netlify has no reliable pre-termination hook** — the RFC defines `flush()` without saying what triggers it or whether it's guaranteed to run. This needs a MUST (buffer + flush at invocation end) and an honest statement that pre-kill flush is best-effort.

### LOST-9 (MED): Package shape reversal + bundling risk
Planning settled on a **package family** (`@hopdrive/eventkit`, `-hasura`, `-observability`, `-batchjobs`, `-console`, `-netlify`) allowing independent versioning. The RFC reversed this to a **single package with deep subpath exports** (`@hopdrive/eventkit/sources/hasura`) — without recording that the reversal happened or why. Deep `exports`-map subpaths are a classic "works locally, module-not-found at deploy" failure with Netlify's esbuild/zisi packager and the repo's `hopdrive-inline` step. Ironic given §3.4 cites bundler determinism as the *reason* for explicit registration. Relatedly: auto-discovery (`loadEventsFromModules('./events')`) was proposed in planning and **never explicitly rejected**; the RFC chose explicit registration (correct for bundlers) but didn't record the rationale, so a future dev may reintroduce dynamic loading.

### LOST-10 (MED): Event-name stability / backward compatibility
The naming chat notes existing names like `move.pickedup` already live in the system and in observability history. The RFC mandates business-semantic dot-notation names and says renaming is a breaking change — but **never addresses migrating the existing names**. If the migration "tidies" names, it orphans observability history and any downstream consumer keyed on the old name. Also unresolved: is the event name an explicit `export const name` or inferred from filename? Planning treated the named export as canonical; the RFC leans filename-implied.

### LOST-11 (LOW-MED): Compare Mode / Flow Manifests presented as settled, vs. "prove one flow first"
The observability chat treated the matcher and Compare Mode as a **hypothesis to validate against one real flow before committing**. The RFC presents the full matcher priority order and classification vocabulary as settled design, downgrades Flow Manifests to a "SHOULD" secondary goal, and never specifies the **backend API/host** the Console's `GET /flows/:flowId` endpoints require. Risk: building speculative tooling ahead of proving the core migration. Recommend explicitly phasing this behind the runtime migration.

---

## Part 3 — Concepts that DID survive (so we don't raise false alarms)

These were checked and are correctly carried into the RFC; don't "fix" them:
- **"Why EventKit Exists" strategic framing** — present (RFC §"Why EventKit Exists").
- **DetectedEvent does NOT carry DetectorContext** — correctly captured (RFC lines 232/374, ADR-007); matches the *revised* planning decision (the chat walked back an earlier version that included `detectorContext`).
- **Detector readability / named-boolean style** — captured (§3.2, §8).
- **One detector + one handler per module** — captured (§3.5, ADR-004).
- **Business event names describe what happened, not the transport** — captured (§3.1).
- **Rejected: fluent detector DSL** — planning explicitly rejected it; RFC does not reintroduce it. Keep it that way.
- **Rejected: domain helpers inside the source plugin; batch jobs as a source adapter** — boundaries captured in §3.3 / §12.

---

## Part 4 — Net assessment: improvement or bug source?

**As a north-star architecture, EventKit is an improvement** and the conceptual spine (EventEnvelope → DetectedEvent → JobExecution, source-agnostic, Observability/BatchJobs as plugins) is sound and matches the existing mental model.

**As a drop-in replacement for a stable system, the RFC as written would be a net source of bugs**, for one structural reason: it specifies the *new* vocabulary precisely and leaves the *seams to the old system* underspecified — and every one of those seams is load-bearing in production. The three that will bite silently:

1. **Execution-mode default** (LOST-3) → fan-out/billing behavior change with no compile error.
2. **Tracking-token loop prevention** (LOST-2) → event storms with no test failure.
3. **Handler→job data channel** (LOST-1) → either mass re-fetch (latency/cost regression across 245 functions) or serialization-hostile smuggling through `metadata`.

The detector layer ports cheaply and is genuinely low-risk (it's already the house style). Everything downstream of detection — handlers, jobs, `scoped-job`, the plugins, the test suite, AR/tracking-token paths — is a **rewrite**, not a port, and the §19 "incremental, minimal-change" framing is optimistic about that.

### Before this RFC is implementation-ready, it must answer (the same three the review raised, now confirmed against planning intent):
1. **The handler→job data channel** — add a typed, non-persisted `input`/`deps` on `job()`, distinct from serialized `metadata`. Restore the planned `HasuraHandlerContext` (LOST-4) so handlers can read `old`/`new`/`operation` with types. Unblocks review items #1, #2, #4, #6.
2. **The per-invocation entry function + `InvocationContext`** — define `runtime.handle(payload, requestContext)` (or equivalent), define `InvocationContext`, and define how per-request config reaches module-scoped plugins (the role `onPreConfigure` plays today). Unblocks review item #9 and LOST-5.
3. **Pinned normative defaults** — `mode:'parallel'`, `continueOnFailure:true`, chosen explicitly for migration parity (LOST-3).

### And it must explicitly specify (currently silent):
4. Tracking-token **control mechanism** for loop prevention, not just the log field (LOST-2).
5. MANUAL handling / `manuallyInvoked()` so console edits stay suppressed (LOST-6).
6. The undefined type cluster — `DurableJobOptions`, `SerializedError` + serialization utilities, `JobProgress`/`JobCheckpoint`, the three `*Logger` interfaces with tiering, `ErrorContext` (LOST-7).
7. Normative buffer-and-flush for Observability + honest best-effort framing for serverless `flush()` (LOST-8).
8. Bundling validation for subpath exports under Netlify/zisi before committing to single-package (LOST-9).
9. Event-name backward-compat / migration policy (LOST-10).

### Process recommendation
Treat detectors as the only true "minimal-change" layer. For the AR / tracking-token / billing paths, **shadow-mode parity testing** (run EventKit alongside the current runtime, diff outputs) is warranted rather than a straight cutover. And because several gaps above are likely RFC-compression artifacts, the fastest path is to **re-expand the RFC from the raw conversations** for LOST-1, -4, -5, -7 specifically — the design largely exists; it just didn't survive the export.
