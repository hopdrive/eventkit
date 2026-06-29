---
'@hopdrive/eventkit': minor
---

`graphqlSink` resilience, from real-DB testing against the canonical observability
schema.

- **`source_job_id` FK graceful-degrade.** `invocations.source_job_id` is a foreign
  key to `job_executions(id)`. If a tracking token carries a prior-job id that isn't
  a recorded job (a non-eventkit writer, observability was down when the parent ran,
  …), the invocation insert FK-violates and would drop the ENTIRE telemetry record.
  The sink now catches that specific violation and retries the invocation WITHOUT
  `source_job_id` — keeping the record, dropping only the unverifiable link.
- **Status mapping to the schema's CHECK constraints.** eventkit emits a richer
  status vocabulary (`timed_out`/`cancelled`/`skipped` jobs, `timeout` invocations,
  `pending`/`detected` events) than the legacy observability CHECK constraints allow,
  so those inserts would be rejected. `mapStatuses` (default on) maps to the allowed
  set (`timed_out`/`cancelled`/`skipped`→`failed`, `timeout`→`failed`,
  `pending`→`detecting`, `detected`→`handling`); override via `statusMap`, or set
  `mapStatuses: false` if you migrate the schema to accept the full set. Mapping is
  applied to a COPY — the caller's batch is never mutated (safe under periodic flush).
- **Transport vs GraphQL errors.** Deterministic GraphQL errors (constraint
  violations, bad mutations) are no longer retried — they surface immediately;
  retry/backoff is reserved for transport failures (network/5xx). Avoids wasting the
  full backoff window on errors a retry can't fix.

Verified end-to-end against a live Hasura observability DB: a ghost `source_job_id`
link degrades to a preserved record with `source_job_id: null`. 4 new tests (75 total).
