---
'@hopdrive/eventkit': patch
---

A job timed out or cancelled by the serverless budget now emits a framework `warn` on the invocation log stream (`onLog` → Grafana), not only an `onError` route.

Previously a budget cancellation or per-job timeout was reported via `onError` (Sentry-style plugins) but produced no log entry, so it was invisible in the log stream when no `onError`-consuming plugin was registered. It now logs a framework warn (`Job '<name>' timed_out` / `cancelled`) so timeouts are visible in Grafana on par with other framework-level events (§11.3 onLog breadth).
