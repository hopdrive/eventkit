---
'hopdrive-eventkit': minor
---

Origin trace decoding, and a behavior change: the Hasura source no longer adopts the inbound trace id as the correlation id by default.

Behavior change (opt back in with `correlationFromTraceId: true` on the `hasuraEvent` source):

- The Hasura DB-event source used to adopt `event.trace_context.trace_id` as the invocation's correlation id when the request carried no explicit `correlationId`. It no longer does. The trace id is a client-controlled conveyance channel, and using it as chain identity merges unrelated chains when clients send static ids and lets a client dictate chain identity. The correlation id is now minted fresh at the root, and the raw trace id is surfaced on `meta.sourceTraceId` (a new well-known SourceMeta key) for a decoder to read.

New:

- `originDecoder` plugin (`hopdrive-eventkit/plugins/origin-decoder`): reads the inbound trace id from `meta.sourceTraceId`, runs a consumer-supplied `decode` function over it, and injects the returned object verbatim into request meta, which observability persists as `context_data.origin`. `decode` is required (eventkit ships no built-in codec); it returns a JSON-serializable object or null (no-op). Runs in `configureInvocation`, so it decodes on root invocations only (downstream hops carry Hasura-minted trace ids the decoder won't recognize). Inert until registered.

Removed:

- The packed origin-id codec (`encodeOriginId` / `decodeOriginId` / `isOriginId` and the magic/version constants) that an earlier draft of this change added to `hopdrive-eventkit/core`. Decoding policy belongs in the consumer now (a registry lookup or a packed-format decoder), not in eventkit.

See `docs/origin-trace-decoding.md` for the registry pattern, the frontend wiring, and the flow-canvas intent. Pairs with Hasura's OTel / B3 propagation, verified in sdk PR #662.
