---
'@hopdrive/eventkit': patch
---

observability: clear a prior attempt's error when a retried job finally succeeds.
`onJobEnd` fires per attempt with the same job id; a job that failed then succeeded
on retry was left with the last failed attempt's `error_message`/`error_stack` on a
`completed` record. Now a successful (no-error) `onJobEnd` clears them. Surfaced by a
chaos/robustness test (a flaky job that recovers after retries).
