---
'@hopdrive/eventkit': minor
---

Enforce job-metadata serializability and strip live clients from persisted batch output (D13).

Job `metadata` MUST be JSON-serializable (§9.4/§12.4) — previously a SHOULD. Now, when Batch is registered, it validates each job's `metadata` before the first persist and fails loud (routed to `onError`) with a message NAMING the offending key path — e.g. `job('proc').metadata.client: a live sdk`. Live infrastructure clients and closures belong in `input`, not `metadata`.

Batch also strips live clients from a job's persisted `output`: if a job result holds an SDK / Apollo Client / graphql-request client (duck-typed), it's replaced with a marker (`[sdk excluded]`) rather than corrupting the durability write. This carries over the legacy `safeSerialize` behavior.

New core exports: `assertSerializableMetadata`, `stripNonSerializable`, `getNonSerializableLabel`, `NonSerializableMetadataError`. The live-client detection is now shared by Batch and Observability from core (no behavior change to Observability).
