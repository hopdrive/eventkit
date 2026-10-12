---
'hopdrive-eventkit': minor
---

Telemetry runs after the response on Netlify v2 (ADR-045).

On a synchronous endpoint the observability writes were most of the response time: two awaited flushes of three sequential Hasura mutations each, ~550ms of a ~620ms reply on a measured partner webhook. They now finish after the reply wherever the platform can keep the invocation alive.

- `RequestContext.waitUntil` is new. When a request carries it, `handle()` hands the end-of-invocation work (`onInvocationEnd` + `onFlush`: observability writes, log-transport flushes) to it instead of awaiting that work before returning. Without it, nothing changes.
- `netlifyV2Platform` supplies it from Netlify's `context.waitUntil`, which `kit.handler()` already receives as its second argument, so `export default kit.handler()` gets it with no code change. `netlifyV2Platform({ afterResponse: 'await' })` keeps the old order. A context without `waitUntil` (an old `netlify dev`) falls back to awaiting, with a one-time warning. Lambda, classic Netlify and the background platforms are unchanged.
- observability `persistJobsAtStart` now takes `'await' | 'background' | boolean` and defaults to `'background'`: the job-start write runs alongside the job body instead of blocking it. `true` keeps the old behaviour. An invocation's writes are chained, so they land in order and the terminal state always wins.
- observability `onFlush` retries only invocations that have ended; `onShutdown` (new) writes whatever is left. Previously a concurrent invocation could be finalized mid-run and lose its terminal state.
- `graphqlSink` sends the three upserts as one GraphQL request (`singleRequest`, default true; Hasura runs it as one transaction) and falls back to the per-table upserts if that request is rejected. On a `source_job_id` FK miss it retries with the link (`sourceJobLinkRetryMs`, default `[250, 1000]`) before dropping it.

Behaviour to expect after upgrading: on Netlify v2, observability rows land a few hundred milliseconds after the response, so anything that reads them right after a call needs to poll. Deferred work still counts against the function's time limit.
