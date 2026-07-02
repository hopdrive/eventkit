---
'@hopdrive/eventkit': minor
---

Webhook `verify` now receives query params, and EventKit ships verify presets (D33).

`WebhookVerifyArgs` gains `query` (the request's query params, case preserved), alongside `body`, `headers`, and `rawBody`. The HTTP platform adapters (lambda, netlify classic, netlify v2) now surface query params on `RequestContext.meta.query`, and the webhook source exposes them as `ctx.query` on the detector/handler context. Some vendors (super-dispatch) key their token on a query param, so a scheme no longer has to reach around the adapter.

New verify presets, importable from `@hopdrive/eventkit/sources/webhook` and usable via `webhook({ verify })`, so repos stop hand-rolling the same schemes:

- `hmacVerify({ secret, header?, algorithm?, toleranceSeconds? })` — Stripe-style `t=`/`v1=` HMAC over `<t>.<rawBody>` (timing-safe compare; optional replay-window check). Requires the platform-preserved raw body.
- `staticHeaderToken({ header, token })` — a fixed token in a named header.
- `sharedSecret({ secret, header?, queryParam? })` — a shared secret in a header or a query param.
- `hasuraPassphrase({ passphrase, header? })` — Hasura event-trigger passphrase (default header `x-hasura-webhook-secret`).

All presets are synchronous and fail safe (a malformed/absent signature is a clean `false`, never a throw). Pair with `rejectUnverified` to reject forged requests at one chokepoint.
