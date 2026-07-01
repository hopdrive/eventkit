# Planning: EventKit Console — Expected Flows + Compare Mode

**Status:** planning (the Console is phased — §16, D9). This doc captures the plan so it
isn't re-derived; it depends on the **shipped** flow generator (ADR-032) and the shipped
Observability records, and specifies what still has to be built.

---

## 1. Where this sits

EventKit answers three questions for every inbound signal, and now has an artifact for each:

| Half | Question | Artifact | Status |
|---|---|---|---|
| **Expected** | What is *supposed* to happen? | the generated flow doc / `toFlowGraph()` (`FlowNode`/`FlowEdge`) — ADR-032 | **shipped** |
| **Observed** | What *did* happen? | the Observability Invocation→Event→Job records (correlation-linked, incl. cross-vendor via ADR-028) | **shipped** |
| **Compare** | Where do they *differ*? | the matcher overlaying Observed on Expected, classified | **planned (this doc)** |

The generator (`kit.describe()` → `@hopdrive/eventkit/flow`) already emits the Expected
graph in the exact `FlowNode`/`FlowEdge` vocabulary the Console needs. The Observability
plugin already emits the Observed records. **Compare Mode is the join between them, plus a
UI.** Nothing about the runtime blocks it now; what's missing is a backend read layer and
the Console modes.

## 2. What the Console becomes

Today's observability viewer (React Flow over invocation records) evolves into an
architecture explorer with three modes over the *same* canvas:

- **Observed** (ships first — useful before any manifest exists): render the recorded
  invocation → event → job tree for a correlation id / invocation, exactly as today, but
  reusing the shared node-id scheme (§4).
- **Expected**: render a flow's `{ nodes, edges }` — either the generated graph
  (`toFlowGraph`, structural) or a hand-authored Flow Manifest (business intent, §15). Same
  node kinds (`source | event | job | sideEffect | terminal`), laid out as the canonical
  shape of the process.
- **Compare**: overlay a specific observed run onto the expected flow and color each node
  by the matcher's classification. Never a production gate (§14) — a lens, not a check.

## 3. The matcher (from §14 — carried, not re-decided)

Classifications: `expected_missing`, `optional_not_taken`, `condition_not_met`,
`observed_success`, `observed_failed`, `unexpected_observed`, `retrying`, `timed_out`,
`cancelled`, `out_of_order`, `extra_invocation_chain`.

Matcher priority: explicit `expectedNodeId` → `flowId`+name → event name → job name →
source+stage → inferred → unmatched. The matcher **MUST preserve uncertainty**
(`matchConfidence: 'inferred'`) and **never hide** an unmatched observed node — an
`unexpected_observed` node is a finding, not noise.

Run it on **one** high-value flow first (mobile-service-dispatch, or the Uber-ride flow —
`external-correlation-chaining.md`) before generalizing (§14 phasing caveat, D9).

## 4. Stable node identity (the linchpin)

Observed nodes, expected nodes, generated-graph nodes, and React Flow ids **must** agree, or
the overlay is guesswork. The rule (§14): **never derive ids from file paths** (they move in
refactors). Use event/job names. The shipped generator already follows this:

```
source                              # the one source node
event:<eventName>                   # e.g. event:rideshare.requested
job:<eventName>:<jobName>           # e.g. job:rideshare.requested:callVendorForRide
sideEffect:<jobName>:<effect>       # from job metadata.sideEffect
```

The Observability records carry `event_name`, `job_name`, `correlation_id`, and
`source_job_id` — enough to reconstruct the same ids at compare time. **Action item:** have
the observed→node mapping reuse these exact id builders (extract them to a shared helper in
`@hopdrive/eventkit/flow` so both sides import one function).

## 5. Backend (the real unbuilt dependency)

The Console needs a query layer over the Observability storage. The v0.1 API shape stands
but the **host/auth/storage-queries must be specified before it ships** (§16):

- `GET /flows/:flowId` — the expected graph (generated + manifest-merged).
- `GET /observations/:invocationId` — the observed tree for one run (+ its correlation chain).
- `GET /compare/:flowId/:invocationId` — expected ⊕ observed, classified.

Where the generated graphs come from at request time: a repo commits its `*.flow.yaml`
(via `eventkit-flow generate`, CI-gated by `eventkit-flow check`), and the backend reads
those committed artifacts — no runtime introspection in the hot path. The observed side is
a query over the existing observability tables (already populated by `graphqlSink`).

## 6. Flow Manifests (the meaning half — still hand-authored)

The generator proves **structure**; a manifest owns **meaning** (§15): stable flow id,
ownership, required-vs-optional branches, human-readable conditions, terminal conditions,
cross-event chains (job writes a row → triggers another kit's event — *not* inferable from
one kit). CI validates a manifest against the generated graph (schema, duplicate ids, edge
endpoints, node kinds, terminal reachability, code-reference validation, generated-graph
comparison). `toFlowGraph()` deliberately emits the manifest vocabulary so a generated graph
can be diffed against — or promoted into — a manifest.

## 7. Build order

1. **Observed mode** on the shared node-id scheme (mostly a refactor of today's viewer).
2. **Backend read API** — specify host/auth/storage queries; serve committed `*.flow.yaml`
   as the Expected graph; serve observability queries as Observed.
3. **Expected mode** — render `toFlowGraph` output / a manifest.
4. **Compare mode + matcher** — on **one** proven flow, then generalize.
5. **Flow Manifest authoring + CI validation** — promote the generated skeleton to an
   intent-bearing manifest for that one flow; add the CI validators.

## 8. Open questions

- **D-console-1:** Where does the matcher live — the Console backend, or a shared
  `@hopdrive/eventkit/flow` function reused by CI? (Lean: a pure function in `flow` so CI and
  the Console share one implementation.)
- **D-console-2:** Manifest storage — per-repo `architecture/*.flow.yaml`, or a central
  registry the backend reads? (Lean: per-repo committed, backend aggregates.)
- **D-console-3:** Backend host/auth — reuse the existing observability service, or a new
  one? (Blocks §16; unresolved in D9.)
