---
'@hopdrive/eventkit': minor
---

Thread `prepare`'s inferred return type through `defineEvent` into `resolve`/`respond` (D32).

`EventModule`/`defineEvent` are now generic over `TPrepared` (inferred from `prepare`), in addition to `TPayload`/`TMeta`. `prepare`'s return type flows into `resolve`/`respond`'s `ctx.prepared` with no cast and no restatement — a missing or mistyped prepared key is a compile error. The source `.prepare()` helpers (`hasuraEvent`, `webhook`, `fakeSource`) preserve the inferred `TPrepared` in their return type rather than erasing it.

Types-only change; the runtime prepare→input merge is unchanged. Compile-checked fixtures live in `src/__type-tests__/contracts.types.ts`, and `src/__examples__/appointment.ready.ts` is the canonical module template (now also demonstrating `ctx.skip`).

Note: threading the prepared type into individual job bodies' `ctx.input` (as opposed to `resolve`/`respond`) is bounded by TypeScript's inference across a heterogeneous, independently-constructed `jobs` array; a job body still annotates its own `JobContext<TInput>`. Full job-body threading would need a prepared-bound job factory (a future, non-types-only API change).
