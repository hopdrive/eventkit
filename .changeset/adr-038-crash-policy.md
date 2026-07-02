---
'@hopdrive/eventkit': minor
---

Configurable crash policy (ADR-038): a source picks how an unhandled processing crash maps to the transport's retry contract.

A **detector** or **`prepare`** crash previously always left `result.ok:true` and returned 200 — right for Hasura event triggers (a poison row must not retry forever) but wrong for inbound vendor webhooks, where the crash silently dropped an event the vendor would have redelivered.

`EventKitPlugin` now carries an optional `crashPolicy: 'ack' | 'signalRetry'`, declared by the source:

- `'ack'` (framework default) — the crash stays in `events[].error`, the invocation returns 200, no retry. Unchanged behavior for existing sources.
- `'signalRetry'` — the crash is escalated to a top-level `result.error` → 500 → the sender retries, and a loud `invocation.log.error` is emitted (Grafana) on top of the existing `onError` route (Sentry).

The **webhook source defaults to `'signalRetry'`** (override via `webhook({ crashPolicy: 'ack' })`). A deliberate `resolve`/`respond` reply is never escalated (it maps to its client status), and a job failure keeps its own durable retry (stays 200). Fully back-compatible: no existing source changes behavior unless it opts in.
