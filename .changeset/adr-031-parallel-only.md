---
'@hopdrive/eventkit': minor
---

Jobs run parallel-only; remove the series/continueOnFailure run controls (ADR-031).

Every module now runs its jobs in parallel with isolated failures. That's fixed, not configurable. `RunOptions.mode` and `RunOptions.continueOnFailure` are gone, and so is `JobOptions.continueOnFailure`. `RunOptions` keeps `timeoutMs` and `metadata`; `JobOptions` keeps `retries`, `timeoutMs`, `name`, `tags`, `input`, and `metadata`.

The runtime always does `Promise.all` over the jobs (a failing job never blocks a sibling; `runOne` never rejects). Series execution is held back as a documented future feature (it invites sequential inter-job coupling, which the declarative model forbids, ADR-025). If it comes back, it comes back behind this same `run.mode` API, so no module changes.

Fail loud, don't downgrade silently: an untyped JS caller that still sets `run.mode: 'series'`, `run.continueOnFailure`, or a job's `continueOnFailure` gets a clear error at register time ("series execution / continueOnFailure is not available in this release (ADR-031)"). The `'skipped'` `JobExecutionStatus` stays in the enum, reserved for the future series feature, even though nothing produces it now.
