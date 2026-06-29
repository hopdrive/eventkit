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
- **No dedicated action platform.** The response *contract* (output → 2xx; thrown
  `ActionError`/`ClientError` → 4xx `{ message, extensions: { code? } }`) rides on the
  source-produced `result.resolved` and is applied by the GENERIC HTTP platforms — transport
  (Netlify classic `{statusCode,body}` vs v2 `Response`) and contract compose, so a Hasura
  action is `createEventKit(hasuraAction).use(netlifyPlatform)` (or `netlifyV2Platform`/
  `lambdaPlatform`). The platforms now honor `resolved` (ClientError status / ack /
  `{message,extensions}`), include `message` on a framework-error 500, and surface request
  headers (+ raw body where preserved) on `RequestContext.meta` for webhook signature checks.

Contract type-tests updated: a `resolve`-only module compiles, `jobs` is optional, `resolve`
is module-level (not a JobOptions field); the brand backstop on `jobs` entries stays.
