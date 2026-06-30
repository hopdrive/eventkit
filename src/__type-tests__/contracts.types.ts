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
// literal (type `false | JobDefinition`), and against non-job entries.
//
// ADR-026: a request/response module adds a module-level `resolve` and `jobs` become
// optional (a resolve-only module is valid). `resolve` is NOT a job option. ADR-020
// covers the typed job-context contribution.

import { job, defineEvent } from '../index.js';
import type { JobContext, EventKitPlugin } from '../core/index.js';

const work = (_ctx: JobContext): void => {};
declare const detector: () => boolean;

// ── ADR-025: a static array of branded jobs is accepted ─────────────────────
void defineEvent({ name: 'ok.event', detector, jobs: [job(work), job(work, { timeoutMs: 100 })] });

// ── ADR-025 (amended): a BARE job function is accepted (auto-wrapped → job(fn)) ──
void defineEvent({ name: 'ok.bare', detector, jobs: [work] });
// ── …and bare + wrapped may be mixed (wrap only when you need options) ───────
void defineEvent({ name: 'ok.mixed', detector, jobs: [work, job(work, { retries: 2 })] });

// ── ADR-025/018 guard: `cond && job(...)` is `false | JobDefinition`, NOT a job ──
declare const cond: boolean;
// @ts-expect-error a conditional entry (false | JobDefinition) is not assignable to the jobs element type
void defineEvent({ name: 'bad.cond', detector, jobs: [cond && job(work)] });

// ── ADR-025 guard: a conditional BARE fn is `false | JobFunction` — still rejected ──
// (auto-wrapping bare fns does NOT reopen conditional inclusion: `false` is neither
//  a JobDefinition nor a function, so it is not assignable to the element type.)
// @ts-expect-error a conditional bare fn (false | JobFunction) is not assignable
void defineEvent({ name: 'bad.cond.fn', detector, jobs: [cond && work] });

// ── ADR-025 guard: a bare entry must be JOBFUNCTION-SHAPED (param ⊇ JobContext),
// not merely "any function" — a function whose parameter is incompatible with
// `JobContext` is rejected (strictFunctionTypes contravariance). So a stray helper
// reference can't slip into `jobs`. (Zero-arg fns and explicit-`any`-param fns are
// accepted — both are inherently JobContext-compatible and are legitimate jobs.)
// @ts-expect-error a number-param function is not a JobFunction (ctx: JobContext)
void defineEvent({ name: 'bad.numparam', detector, jobs: [(_n: number) => 1] });
// @ts-expect-error a specific-object-param function is not JobFunction-shaped
void defineEvent({ name: 'bad.objparam', detector, jobs: [(_deps: { db: string }) => 1] });
// a zero-arg function IS accepted (a job that ignores ctx)
void defineEvent({ name: 'ok.zeroarg', detector, jobs: [() => 'ok'] });

// ── ADR-025/018 guard: a look-alike object without the brand is rejected ────
// @ts-expect-error not branded and not a function
void defineEvent({ name: 'bad.lookalike', detector, jobs: [{ fn: work, name: 'x', options: {} }] });

// ── ADR-025/018 guard: a falsy/empty entry is rejected ──────────────────────
// @ts-expect-error null is neither a JobDefinition nor a function
void defineEvent({ name: 'bad.null', detector, jobs: [null] });

// Note: there is no `handler` field to put an `if`/ternary/`.push` in — conditional
// job inclusion is impossible by construction. A condition lives in the `detector` (a
// distinct business event) or inside a job body (input-driven). See ADR-025 §19.1.

// ── ADR-026: a request/response module compiles with `resolve` and NO `jobs` ──
void defineEvent({ name: 'ok.resolve', detector, resolve: () => ({ accessToken: 't', userId: 1 }) });

// ── ADR-026: `resolve` + optional `jobs` (fire-and-forget side effects) compiles ──
void defineEvent({ name: 'ok.resolve.jobs', detector, resolve: () => 'ok', jobs: [job(work)] });

// ── ADR-026 guard: `resolve` is MODULE-level, not a per-job option ──────────
// @ts-expect-error `resolve` is not a JobOptions field — it belongs on the module
void job(work, { resolve: () => 'nope' });

// (A module with neither `jobs` nor `resolve` is a do-nothing config error — caught at
// REGISTER time, not by the type, now that both are optional. See runtime tests.)

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
