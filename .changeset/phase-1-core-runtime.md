---
'@hopdrive/eventkit': minor
---

Phase 1 — core runtime. `createEventKit`/`use`/`registerEvents`/`validate`/`handle`
and the `run()` executor now work end to end:

- Module-scoped kit, per-request `handle()` lifecycle (normalize → augment → detect
  → handle → finalize) run inside an AsyncLocalStorage invocation store so the free
  `run()` reaches invocation-scoped state without the public signature carrying it.
- `run()` with pinned defaults (parallel + continueOnFailure), strict
  `JobDefinition[]` runtime throw (ADR-018), `augmentJobContext` input merge
  (plugin baselines under handler input) + ambient `trackingToken` (ADR-020),
  per-job timeout, AbortSignal cancellation on budget expiry, and retries.
- PluginManager: lazy instantiation (D22), registration-order best-effort
  notification fan-out, delta-transform merges, capability uniqueness + qualified
  `requires` validation (D20).
- `@hopdrive/eventkit/testing` ships `fakeSource` + `defineFakeEvent`. 14 unit tests
  cover detect+run E2E, merge order, the falsy-entry throw, timeout/cancel,
  parallel-continue / series-stop, retries, and capability validation.

`core` is now pure (types + `job()` + serialization); `createEventKit`/`run` moved
to the runtime layer and are re-exported from the package root.
