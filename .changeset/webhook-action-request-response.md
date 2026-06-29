---
'@hopdrive/eventkit': minor
---

ADR-026 + §7.1/§7.2: webhook + hasuraAction sources and the request/response capability.

- **`resolve` on the module (re-freeze).** `EventModule`/`defineEvent` gain an optional
  `resolve(ctx) => output` (source-agnostic) that computes the invocation's response;
  `jobs` is now OPTIONAL (a module must declare `jobs` and/or `resolve` — register-time
  throw otherwise). The runtime runs `resolve` and `jobs` CONCURRENTLY and sibling-ignorant
  (resolve never reads job results), surfacing `InvocationResult.resolved` ({ output | error }).
  New `ClientError(status, msg)` / `ActionError(msg, code?, extensions?)` carry wire-mapping
  data; `EventSourceType` gains `'action'`.
- **`@hopdrive/eventkit/sources/webhook`** — `webhook({ vendor, verify, eventTypeHeader })`,
  `sourceType: 'webhook'`. Verifies the signature (injected `verify`, synchronous) BEFORE
  normalize and surfaces `ctx.signatureVerified` — never throws on a bad signature. Context:
  `signatureVerified`, `vendor`, `eventType`, `body`, `headers`. `.detector/.prepare/.resolve`.
- **`hasuraAction`** (from `sources/hasura`) — `sourceType: 'action'`; normalizes Hasura's
  `{ action, input, session_variables, request_query }`; context `actionName`/`input`/
  `sessionVariables` (role/userId/email)/`requestQuery`. `.detector/.prepare/.resolve`.
- **`hasuraActionPlatform`** (from `platforms`) — `resolve` output → 2xx body; a thrown
  `ActionError`/`ClientError` → 4xx `{ message, extensions: { code? } }` (Hasura's contract).
  The HTTP platforms (lambda/netlify/netlifyV2) now honor `resolved` too (ClientError status /
  ack) and surface request headers (+ raw body where preserved) on `RequestContext.meta` so
  the webhook source can verify signatures.

Contract type-tests updated: a `resolve`-only module compiles, `jobs` is optional, `resolve`
is module-level (not a JobOptions field); the brand backstop on `jobs` entries stays.
