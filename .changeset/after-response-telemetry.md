---
'hopdrive-eventkit': minor
---

Telemetry runs after the response on Netlify v2 (ADR-045).

On a synchronous endpoint the observability writes were most of the response time: two awaited flushes of three sequential Hasura mutations each, ~550ms of a ~620ms reply on a measured partner webhook. They now finish after the reply wherever the platform can keep the invocation alive.

- `RequestContext.waitUntil` is new. When a request carries it, `handle()` hands the end-of-invocation work (`onInvocationEnd` + `onFlush`: observability writes, log-transport flushes) to it instead of awaiting that work before returning. Without it, nothing changes.
- `netlifyV2Platform` supplies it from Netlify's `context.waitUntil`, which `kit.handler()` already receives as its second argument, so `export default kit.handler()` gets it with no code change. `netlifyV2Platform({ afterResponse: 'await' })` keeps the old order. A context without `waitUntil` (an old `netlify dev`) falls back to awaiting, with a one-time warning. Lambda, classic Netlify and the background platforms are unchanged.
- observability `persistJobsAtStart` now takes `'auto' | 'await' | 'background' | boolean` and defaults to `'auto'`: when the request finishes after the response, the job-start write runs alongside the job body instead of blocking it; otherwise the body waits for it, as before. `true` = `'await'`. An invocation's writes are chained, so they land in order and the terminal state always wins, and parallel jobs share one job-start write rather than queuing one each.
- `kit.shutdown()` waits for end-of-invocation work still running after its response, and a `waitUntil` that throws falls back to awaiting the work in place instead of failing the request.
- observability `onFlush` retries only terminal writes that failed; `onShutdown` (new) writes whatever is left. The batch plugin's `onFlush` touches only rows of ended invocations. Previously a concurrent invocation could be finalized mid-run (and lose its terminal state), or have its periodic log flushing stopped.
- Sinks get a second argument, `{ deferred }`. `graphqlSink` sends the three upserts as one GraphQL request (`singleRequest`, default true; Hasura runs it as one transaction) and falls back to the per-table upserts if that request is rejected, remembering which invocations needed it. On a `source_job_id` FK miss in a deferred write it retries with the link (`sourceJobLinkRetryMs`, default `[250, 1000]`) before dropping it, and remembers links it gave up on so later writes skip the wait (the invocation's final write still tries the link once more, without waiting). A custom sink under `persistJobsAtStart: 'background'` needs its own handling for that FK miss.

Behaviour to expect after upgrading: on Netlify v2, observability rows land a few hundred milliseconds after the response, so anything that reads them right after a call needs to poll. Deferred work still counts against the function's time limit.
