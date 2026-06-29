---
'@hopdrive/eventkit': minor
---

`handler({ before })` pre-handle rejections are now platform-agnostic. Previously a
`before` hook's short-circuit value was returned raw, bypassing the platform — so the
rejection had to be hand-shaped as `{ statusCode, body }`, which is a malformed reply
under `netlifyV2Platform` (Web `Request`/`Response`). Since the reverse-integration
repos are all v2, that was a silent footgun.

Now: `before` returns a platform-agnostic `HandlerShortCircuit` (`{ status, body?,
headers? }`) or `void`, and the platform adapter shapes it via a new `formatRejection`
method — `{ statusCode, body }` on classic/lambda/background, a Web `Response` on v2.
The pre-check (auth, method gate) stays platform-agnostic; "the adapter owns the
response" now holds for rejections too. `formatRejection` is part of the
`PlatformAdapter` contract and implemented by all four built-in adapters.

The handler wrapper resolves the kit (and platform) up front so a `before` rejection
is shaped even though it never reaches `handle()`.
