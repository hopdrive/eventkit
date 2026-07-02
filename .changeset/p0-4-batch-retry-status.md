---
'@hopdrive/eventkit': patch
---

Batch: a row with a live durable retry no longer reads as terminally failed (P0-4, §12.4).

When `durableRetry` schedules a follow-up attempt, the triggering `batch_jobs` row now transitions to a non-terminal retry state (`'delaying'`) instead of terminal `'error'`. Terminal `'error'` is reserved for the exhausted case (no further retry scheduled). On the AP/AR money path this is the difference an operator (and the live `batch_jobs` watch view) needs to tell "retrying" from "failed for good." Matches legacy `@hopdrive/batch` watch-view semantics, where the delay_key-deduped follow-up row carries the next attempt.
