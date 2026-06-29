---
'@hopdrive/eventkit': minor
---

Observability record fidelity, from real-DB testing against the monitoring Console.

- **`source_function` now resolves to the source's business identity.** The platform
  runtime function name is unreliable (`'handler'` under `netlify dev`); the legacy
  plugin used the Hasura trigger name. The Hasura sources now surface that into
  `envelope.meta.sourceFunction` (`hasuraEvent` → `trigger.name`, `hasuraCron` →
  schedule name), and observability prefers `meta.sourceFunction` over the platform
  name (falling back to it, then `'unknown'`). Records now show e.g.
  `source_function: "db-appointments"` instead of `"handler"`.
- **Undetected events are recorded again (Console parity).** Observability now writes
  an `event_executions` row for EVERY detector evaluation — including those that
  didn't fire (`detected: false`, status `not_detected`) — matching the legacy plugin
  and the Console's detected/undetected counts. New `recordUndetectedEvents` config
  (default true) turns it off for leaner batches. `events_detected_count` still counts
  only fired events.

Verified end-to-end against a live Hasura observability DB: `source_function` reads
`db-appointments` (from the trigger name) and undetected `appointment.created` /
`appointment.canceled` evaluations are persisted alongside the fired `appointment.ready`.
