---
'@hopdrive/eventkit': minor
---

Add `webhook({ rejectUnverified })` — one-chokepoint signature rejection (ADR-030).

By default a webhook source's `verify` only annotates `ctx.signatureVerified` and each detector guards with `signatureVerified && …` (§7.1). Set `rejectUnverified: true` and a failed/throwing `verify` is rejected with **401** before any module runs — no per-detector guard needed. Pass `{ status?, message? }` to customize (e.g. `403`). Requires a `verify` function.

Mechanism: the adapter throws `ClientError(status, message)` from `normalize`; the runtime now maps a pre-dispatch `ClientError` (duck-typed `.status`) to that wire status via `resolved.error` — not the framework 500 path — and skips detection/dispatch. This is a general source capability: any source MAY reject a request early by throwing `ClientError` from `normalize`.

Trade-off (documented): a rejected request never becomes an event, so it creates no Invocation/Event/Job record (a framework `warn` is emitted). Keep `rejectUnverified: false` and guard in the detector when you want the forged attempt recorded for telemetry.
