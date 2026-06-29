// =============================================================================
// Negative-type contract fixtures (compile-only; never executed)
// =============================================================================
// Compiled by `tsconfig.typetest.json` (run in CI). Each `@ts-expect-error` asserts
// that a specific misuse FAILS to type-check. If a guard regresses, the expected
// error disappears, the directive becomes "unused", and tsc fails the build.
//
// ADR-025: a module declares a STATIC `jobs` array; there is no handler body, so
// imperative conditional inclusion (`if (x) jobs.push(...)`) is structurally
// IMPOSSIBLE — there is nowhere to write it. The branded `JobDefinition` remains a
// backstop against the one expressible form, `cond && job(...)` inside the array
// literal (type `false | JobDefinition`), and against non-job entries. ADR-020
// covers the typed job-context contribution.

import { job, defineEvent } from '../index.js';
import type { JobContext, EventKitPlugin } from '../core/index.js';

const work = (_ctx: JobContext): void => {};
declare const detector: () => boolean;

// ── ADR-025: a static array of branded jobs is accepted ─────────────────────
void defineEvent({ name: 'ok.event', detector, jobs: [job(work), job(work, { timeoutMs: 100 })] });

// ── ADR-025/018 guard: `cond && job(...)` is `false | JobDefinition`, NOT a job ──
declare const cond: boolean;
// @ts-expect-error a conditional entry (false | JobDefinition) is not assignable to JobDefinition[]
void defineEvent({ name: 'bad.cond', detector, jobs: [cond && job(work)] });

// ── ADR-025/018 guard: a bare function is not a JobDefinition (must wrap in job()) ──
// @ts-expect-error a job function is not a JobDefinition
void defineEvent({ name: 'bad.bare', detector, jobs: [work] });

// ── ADR-025/018 guard: a look-alike object without the brand is rejected ────
// @ts-expect-error missing the `__eventkitJob` brand
void defineEvent({ name: 'bad.lookalike', detector, jobs: [{ fn: work, name: 'x', options: {} }] });

// ── ADR-025/018 guard: a falsy/empty entry is rejected ──────────────────────
// @ts-expect-error null is not a JobDefinition
void defineEvent({ name: 'bad.null', detector, jobs: [null] });

// ── ADR-025 guard: `jobs` is required — a module is not a handler ───────────
// @ts-expect-error missing the required `jobs` array
void defineEvent({ name: 'bad.nojobs', detector });

// Note: there is no `handler` field to put an `if`/ternary/`.push` in — conditional
// job inclusion is impossible by construction, not merely caught by the brand above.
// A condition lives in the `detector` (a distinct business event) or inside a job
// body (input-driven, runs every time and may no-op). See ADR-025 §19.1.

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
