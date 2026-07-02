---
"@hopdrive/eventkit": patch
---

test(runtime): error-path chaos matrix + recording instruments (ADR-036, testing-strategy §1 P0-A)

Add `recordingPlugin()` and `memorySink()` to `@hopdrive/eventkit/testing`, and an
error-path chaos matrix that injects a throw at every seam (normalize, transforms,
detector, prepare, job, resolve, respond, notifications, flush) and asserts the ADR-033
invariants each time (ok truthful, wire mapping, onError routed, flush always ran).
