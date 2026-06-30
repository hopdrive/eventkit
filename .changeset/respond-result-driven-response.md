---
'@hopdrive/eventkit': minor
---

Add `respond` — a result-driven response seam (ADR-029, amends ADR-026).

A request/response module can now declare `respond(ctx, { jobs, ok }) => output` instead of `resolve` when the synchronous reply must reflect the **outcome** of the work. The runtime runs the module's `jobs` under its `run` config, waits for them to settle, then calls `respond` with the settled `JobExecution[]` plus an `ok` flag (every job `completed`/`skipped`). The return becomes the response body; a thrown `ClientError`/`ActionError` maps to the wire error — same plumbing as `resolve`.

This lets you "run N jobs, then answer the webhook based on their combined result" without ejecting from `kit.handler()` to hand-roll `kit.handle()`.

- `resolve` (concurrent, sibling-ignorant fast-ack) is unchanged and `respond` is **mutually exclusive** with it.
- `respond` **requires at least one job** and is **rejected at `validate()` under a `deferredResponse` platform** (background/202 — the response is already sent). New `PlatformAdapter.deferredResponse` flag, set on `netlifyBackgroundPlatform`.
- Fire-and-forget stays the default (declare neither seam). Jobs keep their own retry/durability; `respond` only reads results.

New exports: `RespondFunction`, `JobsResult`.
