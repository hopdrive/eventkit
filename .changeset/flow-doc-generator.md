---
'@hopdrive/eventkit': minor
---

Flow doc generator (§14–§16). Add `kit.describe()` — a pure, read-only structural snapshot of a built kit (source, platform, plugins, every event with its static job set) — and a new `@hopdrive/eventkit/flow` subpath: `toFlowYaml(kit)` (a committed, diff-friendly YAML document of how events flow through the system), `toFlowGraph(kit)` (`{ nodes, edges }` in the `FlowNode`/`FlowEdge` manifest vocabulary), and `describeKit(kit)`.

Ships the `eventkit-flow` CLI (`generate` / `check`) so a consumer repo can regenerate the doc in an npm script and gate drift in CI (`check` fails if the committed file is missing or stale). It introspects the kit you export from a module — no handler runs.

This is the "generator verifies structure" half of the Expected/Observed/Compare design; it's faithful because modules are declarative (ADR-025), so the whole structure is knowable without executing anything. Hand-authored Flow Manifests + Compare Mode remain phased; the generated graph uses the same `FlowNode`/`FlowEdge` vocabulary so it can later be diffed against a manifest. Zero new runtime dependencies (the YAML emitter is built-in).
