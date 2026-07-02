---
'@hopdrive/eventkit': minor
---

loopGuard gains an optional hop-depth ceiling (ADR-034). Off by default.

`loopGuard` can now bound a cycle instead of only making it traceable. Set `warnAtDepth` (log a breadcrumb via the kit logger, keep going) and/or `haltAtDepth` (suppress dispatch before any detector runs, and log). Either one turns on a hop counter that rides the tracking token as an optional 4th segment and increments each hop (a fresh root is depth 1). Unset means unbounded — exactly today's behavior.

Halting works through a new generic runtime seam: a pre-dispatch plugin may set `envelope.meta.suppressDispatch` to a reason string, and the runtime hard-stops the invocation before detection, logs it, and reports it as an `onError` breadcrumb — the invocation is still recorded and flushed, so a halted loop is visible in observability.

The token codec (`@hopdrive/eventkit/plugins/loop-guard` `createTokenCodec`) now supports an optional 4th `hopDepth` segment: `create(source, corr, jobId, hopDepth?)`, `parse` returns `hopDepth`, `getHopDepth(token)`, and `withJobExecutionId(token, jobId, hopDepth?)`. Plain 2-3 part tokens are unchanged, and the 4th segment only ever appears when hop-depth tracking is on.

Migration note: enable hop-depth only AFTER the legacy pipe-token dual-runtime window closes — a 4-part token does not parse under the legacy 3-part `updated_by` extractor.
