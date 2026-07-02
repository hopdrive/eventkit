---
'@hopdrive/eventkit': minor
---

Flow additions (ADR-037): Mermaid emitter, coverage/simulate CLI subcommands, `kit.dryRun`, and the reserved topology schema.

- **`toFlowMermaid(kit)`** — a diff-readable Mermaid `flowchart` of source → event → job → sideEffect, from `@hopdrive/eventkit/flow`.
- **`eventkit-flow coverage`** — a CI gate that fails if any registered event lacks a detector-contract test (scans test files for `detectorContract` + the event name).
- **`eventkit-flow simulate --payload <fixture.json>`** — runs the kit's detectors against a fixture and prints which events/jobs would fire (tolerates async detectors), backed by the new **`kit.dryRun(payload)`** (detection only — no jobs run).
- **Reserved topology schema**: a `JobEffect` convention (`{ type:'db-write', table } | { type:'api-call', vendor }`) read from `job(..., { metadata: { effects } })` and emitted as `sideEffect` nodes; `repo`/`function` origin fields on `toFlowGraph`/`toFlowYaml`. The aggregator itself is deferred — this only reserves the schema so a future org-level merge is lossless.
- **`assertObservedWithinFlow(kit, testInvocationResult)`** (`./testing`) — proto-Compare: asserts an invocation's observed nodes are a subset of the expected flow graph, via the shared `flowNodeId` builders. Validates the Compare-Mode matcher on one real flow.

The legacy `metadata.sideEffect` string still emits its original graph shape (back-compatible).
