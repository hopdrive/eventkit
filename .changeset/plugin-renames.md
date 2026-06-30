---
'@hopdrive/eventkit': minor
---

Rename three plugins for brevity (pre-1.0, no deprecation shims):

- `batchJobs` → `batch`; subpath `@hopdrive/eventkit/plugins/batchjobs` → `@hopdrive/eventkit/plugins/batch`; config type `BatchJobsConfig` → `BatchConfig`. The `batch_jobs` table, the `db-batchjobs` function, and the `BatchJob*` row types (`BatchJobStore`, `BatchJobUpdate`, `BatchJobStatus`, `DelayedBatchJobSpec`) are unchanged.
- `loopPrevention` → `loopGuard`; subpath `@hopdrive/eventkit/plugins/loop-prevention` → `@hopdrive/eventkit/plugins/loop-guard`; config type `LoopPreventionConfig` → `LoopGuardConfig`.
- `grafanaLogger` → `grafana`; config type `GrafanaLoggerConfig` → `GrafanaConfig`. The `@hopdrive/eventkit/plugins/transports/grafana` subpath is unchanged (the folder was already `grafana`).

The `@hopdrive/eventkit/plugins` barrel re-exports the new names. No behavior change.
