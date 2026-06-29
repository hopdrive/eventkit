---
'@hopdrive/eventkit': minor
---

Phase 5 — `hasuraCron` source adapter (ADR-023). `@hopdrive/eventkit/sources/hasura`
now implements the scheduled-trigger sibling of `hasuraEvent`:

- `normalize` — Hasura scheduled-trigger payload `{ name, scheduled_time, payload, id }`
  → `EventEnvelope` (`sourceType: 'cron'`; correlation from request or generated —
  cron has no `trace_context`; `receivedAt` from `scheduled_time`; `meta.sourceEventId`
  from the payload id). Tolerant of malformed input.
- `buildDetectorContext` — `HasuraCronContext` with `scheduleName`, `scheduledAt`,
  `payload` (no rows/operation).
- `buildHandlerContext` — `HasuraCronHandlerContext` (the same schedule data).
- Authoring: `hasuraCron.detector<T>()` / `hasuraCron.handler<T>()`; a cron function is
  `createEventKit(hasuraCron)` and composes with the platform adapters from Phase 4.

6 new tests (69 total): normalize, detector/handler context, and an end-to-end run that
matches a schedule by name and runs jobs with the configured payload.
