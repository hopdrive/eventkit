# EventKit — Testing Strategy

**Status:** Stable plan. **Date:** 2026-07-01. **Owner:** architecture.

EventKit is a mission-critical, low-churn backbone: many HopDrive repos depend on it, it controls
event/job flow across the company, and it won't change often. So the bar is high and specific:

> **A green build is the claim that the package does what the docs say.** The test suite is the
> *executable form of the spec* — every normative MUST in `architecture.md` maps to a named test,
> and `describe` blocks are keyed to their ADR/section.

This doc is the plan behind that claim. It has three parts: (1) package tests, (2) the published
consumer harness `@hopdrive/eventkit/testing`, (3) what more we get from the flow artifact. It drives
ADR-036 (harness surface) and ADR-037 (flow topology metadata), and expands §20 of the RFC.

Baseline at the time of writing: 136 tests / 9 files; CI runs typecheck + negative-type fixtures +
unit tests + dual ESM/CJS build + the Netlify bundle smoke. `./testing` ships `fakeSource`,
`buildDetectorContextFor`/`buildHandlerContextFor`, `defineFakeEvent`, and the event-name↔filename
validator. The ADR-033 hardening tests are already in (`runtime.test.ts` — throwing
`configureInvocation`/`augmentEnvelope`, the `.status`-duck-type fix, branded-`ClientError`
passthrough, deep meta merge).

---

## Part 1 — Package tests

Priority order. P0 = highest value; do these first.

### P0-A. Error-path chaos matrix
The single highest-value addition. Generalize the five hand-picked ADR-033 cases into one
parameterized table that injects a throw at **every seam**:

`normalize`, `configureInvocation`, `augmentEnvelope`, `buildDetectorContext`, `detector`,
`prepare`, `buildHandlerContext`, job body, `handler` `before`, the `after` reply fn, every `on*`
notification, `onFlush`, and the observability sink.

Each row asserts the **same invariants**:
1. `InvocationResult.ok` is **truthful** (a swallowed failure must not report `ok: true`).
2. Retry semantics are correct for that seam: **framework 500** (vendor retries) vs **client status**
   (branded `ClientError` only) vs **isolate-and-continue** (delta transforms + best-effort observers).
3. `onError` fired with the right `phase`.
4. `onInvocationEnd` **and** `onFlush` always ran (they're in `finally`, ADR-033).
5. No buffer or listener growth across the invocation.

One table (~15 rows) means every future refactor of `kit.ts`'s dispatch loop is checked against the
*complete* failure surface, not the five failures someone remembered.

### P0-B. Lifecycle-ordering golden snapshot
Record the full hook-call sequence for one rich invocation — two modules, multi-job, a
`handler({ after: { fromResults } })` reply, plugins registered in a known order — and snapshot it. Plugin callback ordering is a
documented contract (§11) that nothing pins today; a subtle reorder would silently change observability
attribution.

### P0-C. Golden-trace observability snapshots (§20 names these; none exist)
Run a scripted invocation with a **seeded id generator** into a `memorySink()` and snapshot the exact
records — invocation, event, job rows, logs, `source_job_id`, correlation fields. This is the schema
contract with Grafana and the Console. It also permanently locks the "job logs actually persist" fix
(the legacy `job_logs`-had-no-writer gap).

### P0-D. `formatResponse` matrix
`{ resolved output, ClientError, ActionError, framework error, timeout }` × `{ netlify, netlify-v2,
netlify-background, lambda }`. `formatResponse` is what a vendor's retry contract actually sees, so
every cell is a promise we make to an external caller. Include: `after: { fromResults }` under a
`deferredResponse`/background platform is rejected at handler creation; `after: { body }` under
`deferredResponse` is **permitted** (and ignored).

### P1 — known holes (each a small, named test)
- Duplicate event-name registration throws (`kit.ts` guard exists, no test).
- Correlation precedence end-to-end: inbound token **beats** source-derived **beats** fresh mint.
- Timeout logs reach `onLog` (legacy Grafana behavior the spec requires; §11.3 `onLog` breadth).
- `rejectUnverified` produces **no** invocation record + a framework `warn` (assert with a sink wired).
- Non-serializable `metadata` fail-fast with Batch registered (D13).
- Batch retry state: a retryable failure reads `delaying`/`ready`, not terminal `error` (P0-4 / §12.4).
- `after` mode mutual exclusion pinned (declaring both `{ body }` and `{ fromResults }` is an error).
  *Note: moot by construction today — the two `after` modes are mutually exclusive, validated at handler
  creation — so this is a lock, not a bug fix.*
- CLI: `generate` into a temp dir → `check` passes; mutate a module → `check` fails nonzero;
  regenerate twice → **byte-identical** output (determinism is what makes the committed YAML diffable).

### P1 — concurrency & warm-instance soak
Two overlapping `handle()` calls on one kit with no cross-talk in buffers/correlation; then N sequential
invocations asserting **no growth** in abort listeners or plugin buffers. Converts the `race()`
listener-accumulation finding and the warm-lambda-leak concern into permanent guards.

### P2 — property-based (fast-check), scoped to where invariants beat examples
- Token codec parse/format **round-trip** under hostile input (separators embedded in `source`,
  non-UUID correlation ids).
- `serializeError`/`replaceCircularReferences` on arbitrary cyclic structures.
- Envelope-merge folding preserves `meta` keys across arbitrary plugin orders (guards the ADR-033 deep merge).
- Hasura `normalize` never throws uncontrolled on malformed payloads.

### P2 — surface-freeze guards (cheap insurance for a low-churn package)
- **API snapshot** per subpath (enumerate exports, snapshot — accidental export removal fails CI).
  Apply to `./testing` too, not just the runtime.
- `attw` / are-the-types-wrong in CI for dual ESM/CJS hazards.
- **Docs-compile gate (normative):** typecheck the fenced snippets in README/guide, or make docs
  reference `src/__examples__` files that already compile. This is the defect class that produced the
  stale `observability`/`augmentJobContext` examples — eliminate it mechanically.

### P2 — coverage + mutation
Vitest coverage with thresholds (strict on `runtime/` and `core/`, looser elsewhere). **Stryker mutation
testing nightly, not per-PR** — for a low-churn critical package, mutation score is the honest answer to
"do the tests assert behavior or just execute lines." (It would have caught the brittle `✓ good 0ms`
assertion instantly; fix that one regardless — regex `/✓ good \d+ms/`.)

---

## Part 2 — Consumer harness: grow `./testing` into the standard tooling (ADR-036)

**Principle (enforced):** consumers test their modules **through the real runtime, never through mocks
of it.** The legacy suite's failure mode — mocks of `run` arity and `job()` shape that drifted from
reality — is exactly what this prevents. The helpers ship in the same package under `./testing` so
runtime and harness can never version-skew, and `./testing` is held to the same API-snapshot discipline
as the runtime (breaking it is a major-version event).

Build order:

1. **Payload builders per source** (biggest ergonomic gap). `hasuraInsert(table, newRow)`,
   `hasuraUpdate(table, oldRow, newRow, { sessionVars, updatedBy })`, `hasuraManualEdit(...)`,
   `hasuraCronPayload(name, at, payload)`, `hasuraActionPayload(name, input, session)`, and
   `webhookRequest({ vendor, headers, query, body }).signWith(secret)` for the HMAC vendors (so
   `verify` paths are actually testable). Hand-fabricating Hasura payloads is why legacy tests mock the
   framework.
2. **Recording invocation harness.** `testInvocation(kit, rawPayload)` (or a `recordingPlugin()` you
   `use()`) runs the **real** `handle()` and returns an assertable result: which detectors fired, each
   job's resolved `input`/`metadata`, executions, logs, the `after` reply output (`result.resolved`),
   and the hook sequence. A full-kit integration test becomes three lines.
3. **Detector contract helper.** `detectorContract(module, { fires: [...payloads], suppresses:
   [...payloads] })` runs the table and, for `hasuraEvent` modules, **auto-appends a MANUAL-operation
   case** — so console-edit suppression (the named silent-regression risk, D17) is tested by default in
   every consumer repo, not remembered per module.
4. **Memory doubles**, promoted from internals: `memorySink()` (observability), `memoryBatchStore()`
   (the `db-batchjobs-eventkit` PoC already has one — promote it), `capturedLogger()`. Consumers assert
   observability rows and batch transitions with no database.
5. **Chain-simulation harness** (serves the chaining strategy directly). `simulateChain()` runs
   invocation A, takes the token a job stamped (`updated_by` or an echoed vendor field), feeds it into a
   fabricated second payload, and asserts **correlation continuity**: same `correlationId`,
   `sourceJobId` = the parent job. `echoWebhook(...)` (Mechanism A) / `lookupWebhook(...)` (Mechanism B)
   variants + a **miss** case asserting a clean new chain root. hoprides/super-dispatch then assert "the
   vendor webhook rejoined the chain" locally in CI, no vendor involved.
6. **Flow assertions.** `expectFlow(kit).event('move.pickup.started').hasJobs('runAR', 'runARV2')`, plus
   the simpler idiom: snapshot `toFlowYaml(kit)` in a vitest test. A PR that drops a job from an event
   fails in-editor, before the CI-level `eventkit-flow check` even runs.

**Document the standard consumer test pyramid** in the guide, so every repo looks alike:
many pure detector-contract tests → one flow snapshot per kit → a few full-kit integration tests
(builders + memory sink) → `eventkit-flow check` in CI. An agent or a new hire opening any HopDrive
repo finds the same four layers every time.

---

## Part 3 — More from the flow artifact (ADR-037)

The generator's asset: `describe()` is trustworthy because declarative modules can't lie about their
job set. Build on it, cheapest first:

1. **Test-coverage join.** `eventkit-flow coverage` (subcommand or `check` flag) cross-references the
   flow doc against detector-contract tests (by filename convention) and fails on events with no test.
   "Every event in the graph has a test" becomes a repo-level CI gate — the literal "confident at any
   time" property, mechanized.
2. **Mermaid emitter.** `toFlowMermaid(kit)` — near-zero cost, makes the committed flow doc readable in
   PRs and onboarding. Pair with a CODEOWNERS entry on `*.flow.yaml` so event-topology changes get the
   right reviewer; the YAML diff becomes the review artifact for behavior change. (Full HTML emitter is
   **out of scope** — the guide already exists.)
3. **What-if simulation.** `eventkit-flow simulate --payload fixture.json` runs only the (near-pure)
   detectors against a fixture and prints which events would fire and which jobs would run. Safe and
   cheap because detectors are side-effect-light; must tolerate the allowed-but-discouraged async
   detector (§8). Disproportionately useful for agents reasoning about "what happens if this row changes"
   without executing anything.
4. **Cross-kit edge inference (schema now, aggregator deferred).** The generator's blind spot is
   cross-event chains (a job's DB write → another kit's trigger). Close most of it with a **convention**,
   not runtime work: jobs declare `metadata.effects` (e.g. `{ type: 'db-write', table: 'moves' }`,
   `{ type: 'api-call', vendor: 'superdispatch' }`), and every `hasuraEvent` kit already knows its table.
   **Reserve the `repo`/`function` fields and the `effects` convention in the schema now** (cheap,
   lossless-later); an org-level aggregator that merges each repo's committed YAML then proposes cross-kit
   edges (job writes `moves` → kit listening on `moves`) with inferred confidence, for hand-authored
   manifests to confirm. That's the whole-company event topology as a machine-derivable artifact — the
   "agent reasons about the overall architecture" end-state — and it lands before any Console. **Build
   the aggregator later; reserve the schema now.**
5. **Proto-Compare in CI.** A helper that runs one invocation with `memorySink()` and asserts the
   observed record set is a valid **subset** of the expected flow graph, using the shared node-id builders
   from `console-expected-flows.md` §4. That's Compare Mode's matcher hypothesis validated on one flow, in
   a unit test, months before the Console — the D9 sequencing the register asked for.

---

## Where to start

Package: the **error-path matrix**, the **golden-trace snapshots**, the **`formatResponse` matrix**, and
the **CLI tests**. Harness: **payload builders** + **recording harness** + **detector-contract helper**.
Flow: the **coverage join** + **Mermaid emitter**, and **reserve the `repo`/`function`/`effects` schema**.
That set converts "we believe it works" into "the spec is continuously executed," gives every consumer
repo an identical mock-free idiom, and puts the flow artifact on the path to the org-wide reasoning
surface.
