# EventKit Plugin Parity Punch-List (2026-06-28)

> **✅ STATUS: COMPLETE — this is a verification record, not pending work. Do not re-implement.**
> Every **P0** and **P1** item below shipped and is verified in current source:
> - **P0 correlation chaining / parent-job linkage** — `loop-prevention/index.ts` returns `correlationId` + `meta.sourceTrackingToken` + `meta.sourceJobId` from `augmentEnvelope`; `observability/graphql-sink.ts` persists `source_job_id` with FK graceful-degrade.
> - **P0 durable delayed retry + schema** — `batchjobs/index.ts` schedules delayed rows via `store.enqueueDelayed` with `delay_ms`/`delay_key` dedup, and documents the in-process-vs-durable retry boundary.
> - **P1 multi-strategy extraction** — `loop-prevention` ships `updatedByPattern`, session-variable, and metadata-key strategies (defaults on).
> - **P1 grafana** — `transports/grafana` exports **`grafanaLogger`** (not `grafanaTransport`) with two modes: injected `@hopdrive/sdk-server-logger` *or* direct Loki with configurable labels.
> - **P1 sentry** — `transports/sentry` derives the envelope endpoint + `X-Sentry-Auth` from the DSN, with an injectable `send`.
>
> The only items that remain genuinely open are **process sign-offs, not code**: the shadow-mode parity diff for the first migration (P2) and confirming with Rob which extraction strategies HopDrive relies on (P1, line 53). The detailed list below is kept as the record of what was done and why.

**For the build agent (original framing — superseded by the status above).** The prebuilt plugins in `/Users/robnewton/Github/eventkit/src/plugins/` are written and structurally sound, but a parity review against the originals found functional regressions. This list is the work to bring each to **no-loss-of-functionality** parity with `hasura-event-detector` + the `event-handlers` consumer.

Scope: `loop-prevention`, `batchjobs`, `transports/grafana`, `transports/sentry`. **Observability is owned by another agent** — coordinate on the two shared seams flagged below (`source_job_id`, the `ObservabilityBatch` fields), don't duplicate.

Originals to port from / diff against:
- loop-prevention → `hasura-event-detector/src/plugins/tracking-token-extraction/plugin.ts` + `src/helpers/tracking-token.ts`; outbound: `event-handlers/functions/~lib/scoped-job.js`
- batchjobs → `event-handlers/functions/~lib/{batchJobUtils.js,BatchJobLogger.js,scoped-job.js}` + the `db-batchjobs` function + the real `batch_jobs` table (hasura-migrations)
- grafana → `event-handlers/functions/~lib/grafanaLoggerPlugin.js` (delegates to `@hopdrive/sdk-server-logger`)
- sentry → no original plugin; `event-handlers/functions/~lib/utils/sentry.js` for how HopDrive uses Sentry

Priority: **P0** = silent correctness/durability loss on the money path; **P1** = real feature loss; **P2** = verify/confirm.

---

## P0 — Correlation chaining + parent-job linkage (loop-prevention ↔ runtime ↔ observability)

This is one connected thread spanning the runtime and two plugins. The original system threads a single correlation id across a write→event→write→event chain and links each invocation to its **parent** job; the new code drops both.

### Runtime prerequisite
- [ ] Confirm a plugin's `augmentEnvelope` can set `envelope.correlationId` and have it win. In `runtime/kit.ts` the order is `normalize` → `augmentEnvelope` (line ~122) → correlationId resolved as `envelope.correlationId ?? newCorrelationId()` (line ~128). So `augmentEnvelope` returning `{ correlationId }` SHOULD propagate — **verify with a test**, and confirm the Hasura source's `normalize` (which seeds correlationId from `trace_context.trace_id`) does not clobber a token-derived id.
- [ ] **Precedence rule:** an inbound tracking-token correlation id MUST override a source-derived/generated one (chaining beats a fresh trace id). Encode this where correlationId is resolved.
- [ ] Resolve the still-open `RequestContext.correlationId` question from the Phase 1 review — either wire it through or delete the field so there is exactly one correlationId lever.

### loop-prevention inbound (`src/plugins/loop-prevention/index.ts`)
- [ ] In `augmentEnvelope`, when a valid inbound token is found, return **all three**: `correlationId` (the token's correlation id — for chaining), `meta.sourceTrackingToken` (already done), and **`meta.sourceJobId`** (the token's `jobExecutionId`, via `codec.parse(...).jobExecutionId`).
- [ ] Coordinate with the observability agent: observability must read `envelope.meta.sourceJobId` into the invocation record's `source_job_id` so the parent→child chain renders in the Console. (loop-prevention's job is to *expose* it; observability's is to *persist* it.)

**Acceptance:** a job stamps `ctx.trackingToken` into `updated_by`; the next invocation triggered by that write (a) runs under the *same* correlationId, and (b) has `envelope.meta.sourceJobId` === the prior job's id. Add a runtime test that simulates the round-trip end-to-end.

---

## P0 — Durable delayed retry + schema alignment (batchjobs)

`src/plugins/batchjobs/index.ts` reproduces the lifecycle shape but loses the durability semantics that justify `batch_jobs` existing, and writes columns the legacy code never touched.

- [ ] **Port delayed durable retry.** Original `batchJobUtils.createDelayedBatchJob` (`batchJobUtils.js:61`) inserts a **new** `batch_jobs` row with `delay_ms` + `delay_key` (+ uniqueness guard) to schedule a retry that survives a crash. The new plugin's `delaying` branch (`index.ts:145`) only records interim state and relies on core's **in-process** retries — which die with the process. Add a real scheduling path: extend `BatchJobStore` with an `enqueueDelayed({ triggerType, uniqueKey, delayMs, sequence, input })` (or equivalent) and call it from the retryable branch. Preserve the uniqueness/dedup behavior (`delay_key`).
- [ ] **Decide the retry boundary explicitly:** which retries are core/in-process (fast, transient) vs durable/delayed (crash-surviving)? Document it; the original was purely durable-delayed for these jobs.
- [ ] **Verify column names against the real `batch_jobs` table.** Legacy only ever wrote `status`, `output`, and `updatedat` (no underscore), folding logs *into* `output` (`batchJobUtils.js:33-42`). The new plugin writes `started_at`, `completed_at`, `attempt`, `error`, and a separate `logs` field (`index.ts:21-29`). If those columns don't exist, `safeUpdate` swallows the failure **silently**. Check the table in hasura-migrations / the `db-batchjobs` consumer and either map fields in the store adapter or align names. Decide `logs` destination (separate column vs folded into `output`).
- [ ] Keep the circular-ref scrub on persisted output/logs (already using core `replaceCircularReferences` — good; confirm it matches `BatchJobLogger.replaceCircularReferences` behavior).

**Acceptance:** a retryable failure schedules a real delayed row (correct `delay_ms`/`delay_key`, dedup honored); status transitions and persisted fields all hit columns that exist on `batch_jobs`; the live-watch view receives periodic log flushes for a long-running job.

---

## P1 — loop-prevention: multi-strategy extraction

The original enabled four extraction strategies by default (`tracking-token-extraction/plugin.ts:32-43`); the new plugin only parses a token out of `updated_by`.

- [ ] Port the fallback strategies as config-driven (defaults on, matching the original): **metadata keys** (`correlation_id`/`trace_id`/`request_id`/`workflow_id` in the row and in nested `metadata`/`data`/`properties`/`attributes`), **session variables** (`x-correlation-id`/`x-request-id`/`x-trace-id`), **custom field**, plus the **`updatedByPattern`** regex fallback and the **bare-UUID** fallback (`plugin.ts:88-169`).
- [ ] Read both `updatedby` and `updated_by` (`plugin.ts:138`); keep `field` configurable.
- [ ] Confirm with Rob which strategies HopDrive actually relies on — if it's only `updated_by`-token, scope down deliberately and note the drop rather than leaving it implicit.

**Acceptance:** a correlation id supplied via a session variable or a metadata column is extracted and chained, not just the `updated_by` token.

---

## P1 — grafana: match the existing Grafana setup

The original delegates to `@hopdrive/sdk-server-logger` (`grafanaLoggerPlugin.js:20`); the new `grafanaLogger` (then named `grafanaTransport`) talks raw Loki HTTP. The raw approach is architecturally correct per ADR-024 (the SDK-coupled version would be HopDrive-layer), but it won't match the live dashboards out of the box.

- [ ] Verify the Loki **stream labels + log shape** against what `sdk-server-logger` emits and what the existing dashboards/alerts query on; expose them via config (or ship a HopDrive preset) so current dashboards keep working.
- [ ] Preserve **per-job-execution queryability**: the old `scoped-job.js` set the log scope to the exact `jobExecutionId` (`scoped-job.js:40-48`). Add a `jobExecutionId` label/field (from `ctx.job.id`, or parsed from `ctx.trackingToken`) if any dashboard keys on it.
- [ ] Sanity-check flush cadence for long-running background jobs (raw buffer flushes at `onFlush`/invocation end; confirm that's acceptable now that batchjobs owns the live-watch log flush).

**Acceptance:** logs from a migrated function land in the existing Grafana dashboards with the expected labels and are filterable by correlation id and job execution id.

---

## P1 — sentry: make the default sender actually work

`src/plugins/sentry/index.ts` is a clean generic shape, but the default `send` (line 32) POSTs raw JSON to the DSN — that is not Sentry's ingest protocol.

- [ ] Either derive the real ingest endpoint + `X-Sentry-Auth` header from the DSN (Sentry store/envelope protocol), or make `send` required and document that production use injects a `send` delegating to `@sentry/node`. Don't ship a default that silently no-ops against real Sentry.

**Acceptance:** an `onError` reaches a real Sentry test project (or the injected SDK), with `phase`/`correlationId`/`eventName`/`jobName` tags intact.

---

## P2 — cross-plugin verification

- [ ] Each plugin gets unit tests covering the ported behavior above (extend `src/plugins/__tests__/plugins.test.ts`).
- [ ] Shadow-mode note for the first migration (`appointment.ready` / `db-batchjobs`): diff correlation ids, `source_job_id` linkage, batch_jobs row transitions, and Grafana output against the current runtime before cutover — these are the paths that fail silently.

---

## Definition of done

No original functionality is lost: correlation chaining + parent-job linkage work end-to-end; batch jobs schedule durable delayed retries against real columns; Grafana logs match existing dashboards; Sentry actually delivers; the dropped extraction strategies are either restored or consciously scoped out with Rob's sign-off. All four plugins have tests; the bundle smoke + CI stay green.
