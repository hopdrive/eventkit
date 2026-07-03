---
'@hopdrive/eventkit': minor
---

A halted chain is a first-class, loud event (ADR-041).

Stopping a runaway chain is not the same as knowing about it: the hop-ceiling halt used to report an unbranded `Error` (alert routing impossible) and leave an invocation record indistinguishable from a benign zero-event success.

- **`LoopDetectedError`** in core: brand-checked like `ClientError` (`isLoopDetectedError`), serializable, carrying `{ correlationId, depth, ceiling, serviceId, sourceFunction? }` on `.data` so `serializeError` preserves the detail.
- **The suppress seam is structured.** `envelope.meta.suppressDispatch` now accepts `{ reason, error }` (a bare string still works); the runtime reports the error through `onError` with the new phase **`'chain-guard'`** — no string parsing. A new `meta.chainGuardWarning = { error }` seam reports a NON-FATAL error (new `ErrorContext.severity: 'warn'`) while dispatch proceeds.
- **Durable halted marker.** Observability writes `error_message` and `context_data.halted = { depth, ceiling }` on a halted invocation (status `failed`) — halted chains are queryable. A `warn` severity never touches the record.
- **`warnAtDepth` escalates too**: the branded error goes through `onError` at severity `warn` (Sentry `warning` level, Grafana `warn` line) while the chain keeps running — the early alarm fires before the ceiling.
- **HTTP stays 200** on a halt: never invite a retry of a loop.
