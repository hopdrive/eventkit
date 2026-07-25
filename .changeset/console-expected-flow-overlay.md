---
'hopdrive-eventkit': minor
---

Console: add a per-invocation expected-flow overlay. The host wrapper injects an `expectedFlowResolver` (like `userResolver`); it returns an `ExpectedFlowGraph`, which is `toFlowGraph()`'s output plus optional metadata, so a registry can emit it as plain JSON. With the "Expected flow" toggle on (or the `X` hotkey), each invocation's observed records are compared against its expected graph: expected-but-missing steps show as dashed ghost nodes, observed-but-unexpected steps get a small off-contract badge, matched steps are unchanged. It is display only and never a pass/fail gate; an invocation with no resolved flow renders exactly as today.

Also adds an "Expected events" section to the user-action drawer: when a decoded origin carries `expectedEvents`, each is checked against the events observed in the loaded chain.

See `docs/console-expected-flow-overlay.md`.
