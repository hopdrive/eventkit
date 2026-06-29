---
'@hopdrive/eventkit': minor
---

Phase 3 — plugins. Four built-in, config-driven plugins ship as subpath exports
(ADR-024 — no separate `@hopdrive/app-eventkit`; generic mechanism, injected config):

- `./plugins/loop-prevention` — `loopPrevention({ field, read, serviceId, codec })`.
  A generic `source<sep>correlationId<sep>jobExecutionId` codec (separator +
  correlation-id validation are config; ported from the legacy tracking-token.ts).
  Inbound (`augmentEnvelope`) lifts the configured field into
  `envelope.meta.sourceTrackingToken`; outbound (`augmentJobContext`) sets
  `ctx.trackingToken`, continuing the inbound lineage (same source + correlation,
  this job's id) or minting from `serviceId`. `createTokenCodec` exported.
- `./plugins/observability` — `observability({ sink, strict? })`. Pure lifecycle
  observer that buffers an Invocation → Event → Job record hierarchy per invocation
  and flushes ONCE at `onInvocationEnd`/`onFlush` via the injected `sink` (transport
  is the consumer's, not baked in). Best-effort by default.
- `./plugins/batchjobs` — `batchJobs({ store, logFlush? })`. Registration-emergent
  durability (no `durable` flag); `requires: ['source:hasura']`. `augmentJobContext`
  injects the triggering `batch_jobs` row's `input` as the job baseline (handler
  input wins); lifecycle hooks transition the row (processing → done/error/timeout)
  through the injected `store`, self-correlating the row id from the envelope;
  circular-safe output; configurable log flush. Own writes are best-effort.
- `./plugins/transports/grafana` (`grafanaTransport`) and
  `./plugins/transports/sentry` (`sentry`) — generic log/error transports; secrets
  via injected config (never `process.env`); a `send` seam (default `fetch`) for
  testing/custom clients.

All new subpaths are in the exports map, the D8 bundle smoke test (now 10 subpaths,
ESM+CJS), and CI. 10 new tests (42 total).
