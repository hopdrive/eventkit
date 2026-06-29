---
'@hopdrive/eventkit': minor
---

Phase 0 — package skeleton + public type freeze. Dual ESM/CJS build with subpath
exports, the §9/§11 RFC contracts frozen in `/core` (plus the loose helper types:
`Capability`, `JobDefinition`, `PluginFactory`, `NormalizeFn`/`FormatFn`, `KitContext`,
`DetectionResult`/`HandlerResult`, logger tiers, `EventModuleMetadata`,
`SerializedError`), implemented serialization utilities + `job()`, and stubs for the
runtime (`createEventKit`/`run`), the Hasura source, plugins, and platform adapters.
Netlify-bundle smoke test (D8 gate) green.
