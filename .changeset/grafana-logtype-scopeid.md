---
'@hopdrive/eventkit': minor
---

grafana bridge: write `logType` and `scopeId` so logs are field-compatible with the
legacy console's `| json | <field>=…` queries (no console change needed).

- `logType` categorizes each line by phase — `detector` (detection), `handler` (handler
  lifecycle), `job` (per-job + business job logs), `system` otherwise / by error phase.
  Legacy never set a fixed logType; this defines it so phase-filtered queries work.
- `scopeId` mirrors the legacy scoped-job convention: the `jobExecutionId` for job logs
  (including the per-job ✓/✗ lifecycle lines, whose jobExecutionId is hoisted from `data`),
  and the `invocationId` for framework lines (the SDK's default scopeId). Written in the
  body, so the console's body-filter queries match without a real Loki stream label.

eventkit still owns its own invocationId/correlationId/jobExecutionId and takes no
dependency on @hopdrive/sdk-server-logger.
