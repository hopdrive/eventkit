---
'@hopdrive/eventkit': minor
---

Phase 2 — `hasuraEvent` source adapter. `@hopdrive/eventkit/sources/hasura` now
implements the real Shape-3 capabilities:

- `normalize` — Hasura DB-event payload → `EventEnvelope` (correlation id from
  request → `trace_context.trace_id` → generated; `receivedAt` from `created_at`).
  Tolerant of malformed payloads (never throws).
- `buildDetectorContext` — flattened `HasuraDetectorContext` with `operation`,
  `oldRow`/`newRow`/`row`, `inserted()`/`updated()`/`deleted()`/`manuallyInvoked()`,
  and `columnChanged()`/`columnAdded()`/`columnRemoved()` (the `columnChanged`
  semantics port the legacy `columnHasChanged` exactly). Also exported as standalone
  pure helpers.
- `buildHandlerContext` — `HasuraHandlerContext` (data only): operation, rows, role,
  userId, userEmail, receivedAt — no detection helpers leak onto it.

Authoring: `hasuraEvent.detector<T>()` / `hasuraEvent.handler<T>()`. The
`appointment.ready` example module (ported from the legacy db-appointments module)
demonstrates the `switch (ctx.operation)` house style and a declarative handler;
it type-checks and is covered by detector unit tests (insert/update/delete/manual/
malformed) plus an end-to-end run through a Hasura kit.

Testing: `@hopdrive/eventkit/testing` adds `buildDetectorContextFor` /
`buildHandlerContextFor` for unit-testing detectors/handlers against any source.
14 new tests (32 total). `run()`'s `jobs` parameter is `JobDefinition<any>[]` so
typed jobs compose (the ADR-018 brand guard is unaffected). `hasuraCron` remains
stubbed for Phase 5.
