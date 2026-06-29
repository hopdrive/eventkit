// =============================================================================
// Negative-type contract fixtures (compile-only; never executed)
// =============================================================================
// Compiled by `tsconfig.typetest.json` (run in CI). Each `@ts-expect-error`
// asserts that a specific misuse FAILS to type-check. If a guard regresses — e.g.
// the JobDefinition brand stops rejecting `cond && job(...)` — the expected error
// disappears, the directive becomes "unused", and tsc fails the build. This is
// the type-level half of ADR-018 (declarative handlers / no conditional jobs) and
// ADR-020 (typed job-context contribution).

import {
  job,
  run,
  type DetectedEvent,
  type JobContext,
  type EventKitPlugin,
} from '../core/index.js';

declare const event: DetectedEvent;
const work = (_ctx: JobContext): void => {};

// ── ADR-018: a strict JobDefinition[] is accepted ──────────────────────────
void run(event, [job(work), job(work, { timeoutMs: 100 })]);

// ── ADR-018 guard: `cond && job(...)` is `false | JobDefinition`, NOT a job ──
declare const cond: boolean;
// @ts-expect-error conditional entry (false | JobDefinition) is not assignable to JobDefinition[]
void run(event, [cond && job(work)]);

// ── ADR-018 guard: a bare function is not a JobDefinition (must wrap in job()) ──
// @ts-expect-error a job function is not a JobDefinition
void run(event, [work]);

// ── ADR-018 guard: a look-alike object without the brand is rejected ────────
// @ts-expect-error missing the `__eventkitJob` brand
void run(event, [{ fn: work, name: 'x', options: {} }]);

// ── ADR-018 guard: a falsy/empty entry is rejected ──────────────────────────
// @ts-expect-error null is not a JobDefinition
void run(event, [null]);

// ── ADR-020: a valid job-context contribution type-checks ───────────────────
const validPlugin: EventKitPlugin = {
  name: 'valid-contributor',
  augmentJobContext: () => ({ input: { workUnit: 1 }, ambient: { trackingToken: 'tok' } }),
};
void validPlugin;

// ── ADR-020 guard: `ambient` is not an open bag — only known fields land ────
const badAmbient: EventKitPlugin = {
  name: 'bad-ambient',
  // @ts-expect-error `nope` is not a contributable ambient field
  augmentJobContext: () => ({ ambient: { nope: true } }),
};
void badAmbient;

// ── ADR-020 guard: the old `context` channel is gone (merged into a void) ────
const deadContext: EventKitPlugin = {
  name: 'dead-context',
  // @ts-expect-error `context` is not part of the contribution contract (use `input`/`ambient`)
  augmentJobContext: () => ({ context: { foo: 1 } }),
};
void deadContext;
