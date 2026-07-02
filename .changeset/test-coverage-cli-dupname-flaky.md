---
'@hopdrive/eventkit': patch
---

Test coverage + build hygiene: `eventkit-flow` CLI tests (`generate`/`check`), a duplicate-event-name registration test, and a de-flaked timing assertion.

Adds coverage for the `eventkit-flow` CLI (previously untested despite being ADR-032's deliverable): `generate` to a file and to stdout, `check` passing when current and failing on stale/missing, and argument-error paths. Adds a test for the duplicate-event-name register guard. Replaces the load-sensitive `'✓ good 0ms'` assertion with a `/✓ good \d+ms/` match. The build now excludes `__tests__` directories, so test fixtures no longer ship to `dist`.
