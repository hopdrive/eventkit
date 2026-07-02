---
'@hopdrive/eventkit': minor
---

Harden the pre-dispatch pipeline (ADR-033): isolate transforms, brand-check rejection, always flush.

The pre-dispatch delta transforms (`configureInvocation`, `augmentEnvelope`) now run isolated. A throw from one plugin is routed to `onError` and the pipeline continues with the last-good merged value, so one plugin's bug can't sink the whole invocation. A plugin that must fail the request loudly throws a branded `ClientError` (re-thrown, not isolated) or opts into a strict mode.

The pre-dispatch `ClientError` fast-path is now brand-checked. `ClientError` carries a registry-`Symbol` brand and there's a new `isClientError(err)` guard. Only a genuine, intentional `ClientError` maps to a client response via `resolved.error` (`ok:true`). Any other pre-dispatch error — even one that happens to carry a numeric `.status`, like a DB blip from a `correlationResolver` lookup — becomes a framework 500 (`ok:false`) so the vendor retries, never a silent success.

`onInvocationEnd`/`onFlush` moved into a `finally`, so the invocation record always flushes and the buffer never leaks on a warm lambda after a pre-dispatch throw.

`augmentEnvelope` deltas are deep-merged one level at `meta` (`meta: { ...merged.meta, ...partial.meta }`), so a plugin returning `{ meta: { myKey } }` can't wipe a sibling's `sourceTrackingToken`/`sourceJobId`.

`correlationResolver` gains `onLookupError: 'ignore' | 'reject'` (default `'ignore'`). `'ignore'` lets a lookup throw propagate to the isolating pipeline (event proceeds un-correlated). `'reject'` rethrows it as a branded `ClientError(503)` so the source retries.

New export: `isClientError`.
