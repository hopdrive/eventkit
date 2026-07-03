---
'@hopdrive/eventkit': minor
---

Expand the published `@hopdrive/eventkit/testing` harness (ADR-036) — a versioned, mock-free consumer test surface driven by the real runtime.

New exports:
- **Payload builders**: `hasuraInsert`, `hasuraUpdate` (with an `updatedBy` convenience for the loop-guard field), `hasuraManualEdit`, `hasuraDelete`, `hasuraCronPayload`, `hasuraActionPayload`, and `webhookRequest(...).signWith(secret)` (HMAC-signs so `verify`/`hmacVerify` paths are exercised).
- **`testInvocation(kit, payload)`**: runs a real `handle()` and returns an assertable snapshot — fired events, each job's execution/output, the response, logs, observability records, hook sequence, errors.
- **`detectorContract(source, module, { fires, suppresses })`**: runs a detector table through the real source context; for a `hasuraEvent` module it auto-appends a MANUAL-operation suppress case (mechanizes the D17 console-edit guard).
- **Memory doubles**: `memoryBatchStore()` (records `update`/`enqueueDelayed`), `capturedLogger()`.
- **`simulateChain(...)`**: proves correlation-id continuity across a two-hop chain (ADR-028), incl. the miss → clean-root case.
- **`expectFlow(kit)`**: fluent assertions over a kit's declared events and static job sets.

The guide documents the standard four-layer consumer test pyramid. All additions are covered by the API-surface snapshot.
