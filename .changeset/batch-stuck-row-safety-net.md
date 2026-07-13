---
'hopdrive-eventkit': minor
---

batch: opt-in safety net for triggering rows that no job ever runs for

The batch plugin only moves a `batch_jobs` row when a job actually runs for it: `onJobStart` sets `processing`, `onJobEnd` sets `done`/`error`/`timeout`. So a row that triggers the function but never has a job run stays `pending` forever with no trace. That happens when an unrecognized `trigger_type` matches no detector, or when a detector or `prepare` throws before dispatch. This is the same stuck-pending gap event-handlers PR #476 fixed for the legacy runtime.

New `batch({ safetyNet: true })`. When it is on, `onInvocationEnd` notices that zero jobs ran for the triggering row and flips it `pending` to `error`, then logs a loud error (which flows to Grafana / the observability sink). The row becomes visible and is retryable through the existing UPDATE to `pending` path.

The flip goes through a new race-safe store method, `store.markStranded(id, output)`, which must only update a row still in a pre-processing state (`pending`/`ready`/`delaying`) and return whether it actually changed one. That way it never clobbers a row a job legitimately advanced, and the plugin only logs on a real save. `safetyNet: true` without `store.markStranded` throws at construction.

Off by default, so there is no behavior change until you opt in and wire the store method.
