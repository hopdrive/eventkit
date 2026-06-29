---
'@hopdrive/eventkit': minor
---

Phase 4 — platform adapters (`@hopdrive/eventkit/platforms`, ADR-021). Deployment-
runtime specifics (invocation signature, payload extraction, time budget, response
shape) now sit behind `PlatformAdapter` capability providers, registered via
`kit.use(...)`. Event modules, handlers, and jobs stay platform-agnostic.

- `lambdaPlatform()` — raw AWS Lambda `(event, context)`; bucket A native countdown;
  `{ statusCode, body }`.
- `netlifyPlatform()` — Netlify classic `(event, context)`; bucket A; `{ statusCode, body }`.
- `netlifyBackgroundPlatform({ maxExecutionMs? })` — Background Functions; returns
  `202`; bucket A native countdown, else a long computed budget (~15 min).
- `netlifyV2Platform({ maxExecutionMs? })` — modern v2 `(Request, Context)`; awaits
  `request.json()`; bucket B computed deadline (D21); returns a Web `Response`.

The time budget collapses to the three strategies, all surfaced as
`RequestContext.getRemainingTimeMs` — so cancellation + best-effort flush work
uniformly. `kit.handler()` is the zero-boilerplate entry (the adapter owns the
signature + response); `kit.handle(...args)` stays the manual/raw escape hatch.

`handle()` now wraps the invocation: a framework-level failure (normalize/
extractPayload/…) yields a fatal `InvocationResult` (top-level `error`) → 5xx → the
platform/Hasura MAY retry; a business crash (detector/handler/job) stays in
`events[]` with no top-level error → 200 → no retry (no-retry contract preserved).

Detect-and-warn (ADR-021): if a deadline-capable runtime is detected at init but no
platform adapter is registered, the kit warns once.

9 new tests (63 total).
