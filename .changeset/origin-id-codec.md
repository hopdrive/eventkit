---
'hopdrive-eventkit': minor
---

Origin-id codec and origin-decoder plugin.

- `encodeOriginId` / `decodeOriginId` / `isOriginId` (from `hopdrive-eventkit/core`) — a
  pure, dependency-free, isomorphic codec for a structured 32-hex trace/correlation id.
  It packs a magic marker, a version, an opaque minting-surface number (`originId`, 0-255),
  and an env into the first 11 hex chars, with 84 random bits after. A frontend mints one
  and sends it as `x-b3-traceid`; with Hasura's OpenTelemetry config on it lands as the
  invocation's correlation id. The codec knows numbers, not names, so mapping an originId
  to a display name is consumer config. Deliberately no timestamp and no user identity, and
  the id is display-only (a client mints it, so it is spoofable).
- `originDecoder` plugin (`hopdrive-eventkit/plugins/origin-decoder`) — decodes the chain's
  final correlation id and, when it is an origin id, injects an `origin` object into request
  meta so observability persists it as `context_data.origin` and the console can read it.
  Supports a custom `decode` function and an `originNames` map for display names. It runs in
  `configureInvocation` (after loopGuard/correlationResolver recover the correlation id), so
  it always decodes the chain root's id. No-op on any id it can't decode; inert until a
  consumer registers it.

See `docs/origin-id.md` for the format table, the frontend minting example, and the
non-goals. This pairs with Hasura's OTel / B3 propagation (verified in sdk PR #662).
