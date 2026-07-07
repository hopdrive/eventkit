---
'hopdrive-eventkit': patch
---

**Fix silent terminal-state loss on the observability final flush** — a `job_executions`
row could stay `running` with `duration_ms: null` after its invocation already read
`completed`. The final flush deleted the per-invocation buffer BEFORE awaiting the sink and
swallowed any error, so a partial batch (the invocations mutation lands, then the
events/jobs mutation throws a deterministic GraphQL-level error, which is never retried)
permanently and silently lost the job's terminal state.

Three defenses:

- **`flush()` no longer discards state before it's durable** — the buffer is deleted only
  AFTER the sink resolves. A failed final flush now RETAINS the buffer, so `onFlush` (which
  runs in the same `handle()` `finally`, right after `onInvocationEnd`) retries the terminal
  write instead of dropping it.
- **Sink failures are surfaced, not swallowed** — new `onSinkError?(err, { invocationId,
  final })` option on `observability(...)`, defaulting to a `[eventkit]` `console.warn`.
  Ignored under `strict` (the error is rethrown as before). Silent telemetry loss was the
  worst failure mode for a telemetry system.
- **`graphqlSink` graceful-degrades an events/jobs GraphQL error** — a deterministic
  `GraphqlResponseError` on the `job_executions`/`event_executions` mutation retries ONCE
  with the droppable payload columns shed (`result`, `job_options`, error stacks), mirroring
  the existing `source_job_id` degrade, so the row lands lossy-but-terminal (`status`
  preserved) rather than being lost entirely.

Additive and backward-compatible: `onSinkError` defaults to the console warning, and the
sink degrade only triggers on a mutation that would otherwise have thrown.
