---
'hopdrive-eventkit': minor
---

**Add a kit-level `prepare` → `ctx.provided`** — a first-class, once-per-invocation context
provider, so sharing a live ref (a GraphQL executor, an authenticated vendor client, a
resolved tenant config) across an invocation no longer requires hand-rolling an
`augmentJobContext` plugin.

Declare it as a reserved key on `createEventKit`'s config:

```ts
const kit = createEventKit(hasuraEvent, {
  prepare: () => ({ executor: createFetchExecutor({ url, adminSecret }) }),
}).use(netlifyV2Platform).registerEvents(events);
```

It runs **once per invocation** (after `normalize`, before detection) and its returned
object is attached as `ctx.provided` — the SAME instance — on **every detector, module
`prepare`, and job** of that invocation.

- **Request-scoped, never serialized.** Unlike `envelope.meta` (persisted to observability),
  `provided` is safe for live objects. Defaults to `{}` when unset.
- Distinct from the existing scopes: kit `prepare` → `ctx.provided` (per **invocation**,
  whole stack); module `prepare` → `ctx.input`/`ctx.prepared` (per **event**); per-job
  `input` (per **job**, merges highest).
- Also runs under `dryRun` so detectors that read `ctx.provided` behave identically — keep it
  cheap. A throw aborts the invocation cleanly, reported as the new `ErrorPhase` value
  `'prepare'`; no jobs run.

New public types: `KitPrepareContext`, `KitPrepareFunction`. `DetectorContext`,
`HandlerContext`, `InvocationContext`, and `JobContext` gain a `provided: Record<string,
unknown>` field. Additive and backward-compatible (`provided` is `{}` when no kit `prepare`
is configured).
