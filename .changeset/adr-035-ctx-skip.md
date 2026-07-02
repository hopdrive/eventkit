---
'@hopdrive/eventkit': minor
---

Add `ctx.skip(reason)` — a first-class job self-skip that records `condition_not_met` (ADR-035).

`JobContext` gains `skip(reason: string): never`. Calling it stops the job and records the branch-not-taken as structured metadata (`metadata.conditionNotMet = { reason }`), while the terminal status stays `'completed'` (the job ran; it chose to do nothing). It is NOT the reserved `'skipped'` status (that stays for the deferred series feature, ADR-031), and it is not a failure — it never retries.

This is what a Pattern-B short-circuit should use: `if (!driverId) return ctx.skip('no driver on this outcome')`. A no-op is now distinguishable from a job that did real work in Observability, and it produces the data Compare Mode's `condition_not_met` classification needs.
