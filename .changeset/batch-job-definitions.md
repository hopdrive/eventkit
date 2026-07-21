---
'hopdrive-eventkit': minor
---

Batch plugin: define-once batch jobs and a first-class insert path.

- `batchJob({ triggerType, input? })` — pairs the trigger_type string with an optional
  input codec (zod-compatible `parse`) and derives the two standard event-module slots:
  a `detector` (INSERT of that trigger_type + the UPDATE→pending replay path) and a
  `job()` `input` mapper that parses the row's `input` into the job's typed `ctx.input`.
- `createBatchJob(executor, def, input, opts?)` — the sanctioned write path: validates
  through the same codec, stamps the trigger_type, inserts `status: 'pending'`, forms
  the legacy `delay_key = triggerType-uniqueKey` dedup (a live collision reports
  `deduped: true` instead of inserting).
- `batch({ executor })` — builds the canonical `batch_jobs` GraphQL store
  (`executorBatchJobStore`) from a mutate-capable executor; hand-rolled `store` still
  supported for tests/portability.
- `batchJobsActionHandler({ executor, batchjobs, passphrase? })` — Netlify 2.0 handler
  for a Hasura action `createBatchjob(trigger_type, input)`; refuses trigger_types the
  service doesn't define and runs the same codec validation.
