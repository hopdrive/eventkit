---
'@hopdrive/eventkit': minor
---

Plugin parity punch-list — bring loop-prevention, batchjobs, and the transports to
no-loss-of-functionality parity with the legacy runtime + consumers.

- **P0 correlation chaining + parent-job linkage.** `loopPrevention.augmentEnvelope`
  now sets `envelope.correlationId` to the inbound token's correlation id (chaining
  beats a fresh source/trace id — runtime precedence documented), alongside
  `meta.sourceTrackingToken` and `meta.sourceJobId`. A write→event→write chain runs
  under one correlationId and links each invocation to its parent job (test:
  job-row id === outbound token segment === next invocation's `source_job_id`, and
  both invocations share the correlationId).
- **P0 batchjobs schema alignment + durable retry.** Writes ONLY `status` + `output`
  (the real `batch_jobs` columns), folding logs/error/result into `output` — the
  previous `started_at`/`completed_at`/`attempt`/`error`/`logs` writes hit columns
  that don't exist and were silently swallowed. Added `store.enqueueDelayed` + opt-in
  `durableRetry`: a failed job schedules a crash-surviving delayed `batch_jobs` row
  (delay_ms + delay_key dedup, ported from `createDelayedBatchJob`). Retry boundary
  documented: core `options.retries` = fast in-process; `durableRetry` = durable.
- **P1 loop-prevention multi-strategy extraction.** Ported the legacy strategies
  (config-driven, defaults on): `updated_by` token → `updatedByPattern` → bare UUID,
  metadata keys (row + nested metadata/data/properties/attributes), session variables,
  and a custom field; reads both `updated_by` and `updatedby`.
- **P1 grafana.** Job logs now carry `jobExecutionId` (= `ctx.job.id`) and
  correlation/event/job fields as structured line data — never high-cardinality Loki
  stream labels.
- **P1 sentry.** The default sender now uses the real ingest protocol: it derives the
  envelope endpoint + `X-Sentry-Auth` header from the DSN and POSTs a Sentry envelope
  (no more raw-JSON no-op), while `send` stays injectable for `@sentry/node`.

12 new tests (54 total).
