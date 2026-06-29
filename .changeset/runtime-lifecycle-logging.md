---
'@hopdrive/eventkit': minor
---

runtime: emit concise framework lifecycle logs (transport-agnostic).

The runtime now emits an info-level narrative through `onLog` for parity with the
legacy detector's Grafana/console output: one `<event> ⭐ detected` line per detected
event, then `<event> running N jobs`, a `✓/✗ <jobName> Nms (ErrorType?)` line per job,
and `<event> completed N jobs (M failed)`. `scope` (`detection`/`handler`/`job`),
`eventName`, `jobName`, and `jobExecutionId`/`status` are structured fields; the message
is human-readable. Skipped for empty job lists (probe handlers). Lifecycle still lands in
the observability DB rows — this restores the same lines in any log sink (e.g. the
grafana bridge) that the legacy GrafanaLoggerPlugin forwarded.
