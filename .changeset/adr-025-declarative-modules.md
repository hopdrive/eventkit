---
'@hopdrive/eventkit': minor
---

ADR-025: event modules are fully declarative; the runtime runs the jobs. **BREAKING.**

An event module is now `defineEvent({ name, detector, prepare?, jobs, run? })` — not a
handler that calls `run()`:

- `EventModule.handler` is removed; `HandlerFunction` is removed. A module declares a
  STATIC `jobs: JobDefinition[]` array the runtime executes during dispatch. With no
  handler body, conditional job inclusion is impossible by construction (the branded
  `JobDefinition` + a register-time throw remain the backstop).
- `run()` is no longer exported — it is runtime-internal. `RunOptions` move onto the
  module as `run: {…}` (defaults still pinned: parallel + continue-on-failure).
- New `prepare(ctx) => shared` runs ONCE before the jobs; its result merges into every
  job's `ctx.input`. Merge precedence (lowest→highest): plugin baselines (ADR-020) →
  `prepare` output → the job's own `input`.
- `JobOptions.input` accepts a static object OR a pure mapper `(ctx: JobInputContext) =>
  input`, resolved once before the job runs.
- New `defineEvent(module)` typed identity helper; sources expose `.prepare` (replacing
  `.handler`) alongside `.detector`.
- Register-time validation throws on a non-job entry in `jobs` (earlier than the old
  run-time check). The AsyncLocalStorage invocation store is removed (the runtime runs
  jobs directly, so the free `run()` no longer needs to reach invocation state).

Three hard rules are now enforced/encoded: no conditional job inclusion, no fan-out, no
inter-job dependencies.
