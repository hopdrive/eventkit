---
'hopdrive-eventkit': minor
---

Add the `originDecoder` plugin. Give it a `decode` function that turns an id the frontend sends (as the `x-b3-traceid` header, arriving at `meta.sourceTraceId`) into a small object, and it lands at `context_data.origin` on the first invocation of a chain, for display in observability and the console.

Behavior change: the Hasura source no longer uses an inbound `trace_context.trace_id` as the chain's correlation id by default; set `correlationFromTraceId: true` on the `hasuraEvent` source to keep that behavior.

See `docs/origin-trace-decoding.md`.
