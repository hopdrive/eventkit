---
'@hopdrive/eventkit': minor
---

A correlation id is a UUID **or** 32-hex dashless (ADR-040).

Hasura roots a chain's correlation id in `trace_context.trace_id` — 32 hex characters with no dashes — so the codec's UUID-only `validateCorrelationId` silently rejected every token built from a trace-rooted chain: parsing fell back to treating the whole token as a bare id, tokens nested inside tokens, and `sourceJobId`/hop depth were lost with no error anywhere.

The codec now accepts both shapes with one widened check, exposed as `isCorrelationIdShape` from `@hopdrive/eventkit/core`. Trace-id adoption stays (free APM linkage between chains and traces), and the `hopdriveLoopGuard` preset can keep validation on.
