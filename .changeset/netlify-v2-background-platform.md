---
'hopdrive-eventkit': minor
---

Netlify Functions 2.0 support + observability lineage fix (surfaced by the hoprides v2 migration).

**Add `netlifyV2BackgroundPlatform`** — the modern Netlify v2 `(Request, Context) → Response`
shape for a function declared `export const config = { background: true }` (no `-background`
filename suffix). It reuses `netlifyV2Platform`'s Web-Request plumbing but runs as a
deferred-response platform: `deferredResponse: true` (blocks result-driven `respond` modules),
a ~15-minute default budget, and a `202` `Response`. Import from `hopdrive-eventkit/platforms`.

**Fix orphaned observability origins** — the plugin buffered a job's `job_execution` row in the
parent invocation's memory and only flushed it at invocation end. A long-running job's DB
write-backs spawned child invocations (in separate processes) that hit the sink before the
parent flushed, so their `source_job_id` FK failed and the sink's graceful-degrade silently
dropped the link — rendering them as false extra "origins" in the console flow graph. The job's
row is now persisted (status `running`) during `onJobStart`, before the job body runs (the
runtime awaits `onJobStart`), so the parent row is durable before any side effect can spawn a
child. Idempotent (sink upserts); gated by a new `persistJobsAtStart` option (default true).

**Preserve `rawBody` on the v2 platforms** (surfaced by the sparkserv migration) — the webhook
source's HMAC `verify` needs the exact request bytes, but `netlifyV2Platform`/
`netlifyV2BackgroundPlatform` consumed the body via `req.json()` and never exposed `rawBody`, so
signature verification always failed on v2. The adapters now read the Web `Request` body once as
text, cache the exact bytes (WeakMap, no mutation of the Request), return the parsed JSON as the
payload, and expose the bytes as `request.meta.rawBody`. Backward-compatible (rawBody was simply
absent before); JSON parsing tolerates a non-JSON body (returns the raw string).
