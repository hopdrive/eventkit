// =============================================================================
// Event modules (§18, ADR-025)
// =============================================================================
// An event module is a fully DECLARATIVE record — `defineEvent({ name, detector,
// prepare?, jobs, run? })` — NOT a handler that calls `run()`. The detector answers
// "did this business event occur?"; `jobs` is a STATIC ARRAY LITERAL the runtime
// executes when it did. There is no handler body, so conditional job inclusion is
// impossible by construction (the JobDefinition brand is a backstop). An optional
// `prepare(ctx)` runs ONCE before the jobs and returns request-scoped shared refs
// (an initialized sdk, fetched rows, helper closures) the runtime merges into every
// job's `ctx.input`. Three hard rules (ADR-025): no conditional inclusion, no
// fan-out (one declaration is never expanded into N jobs), no inter-job deps.
//
// A module does NOT declare an HTTP reply (ADR-026, re-amended): one invocation has
// one wire reply and it belongs to the INVOCATION layer — `kit.handler({ after })`
// declares it (a constant `{ body }`, or `{ fromResults }` composing from the
// full InvocationResult across every detected event). Modules own detection + jobs;
// with no `respond` declared the platform returns its standard ack once jobs finish.

import { asEventName, type EventName } from './brands.js';
import type { DetectorContext, HandlerContext } from './context.js';
import type { JobDefinition, JobFunction, RunOptions } from './job.js';

export type DetectorFunction<
  TPayload = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> = (ctx: DetectorContext<TPayload, TMeta>) => boolean | Promise<boolean>;

/**
 * Runs ONCE before a detected event's jobs and returns a request-scoped shared
 * object (an initialized `sdk`, fetched rows, `user`/`role`, helper closures). The
 * runtime merges the returned object into every job's `ctx.input` (ADR-025). This
 * is data preparation only — it MUST NOT select jobs (no conditional logic that
 * changes which jobs run; that lives in the detector or inside a job).
 */
export type PrepareFunction<
  TPayload = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TPrepared extends Record<string, unknown> = Record<string, unknown>,
> = (ctx: HandlerContext<TPayload, TMeta>) => TPrepared | Promise<TPrepared>;

/**
 * Optional, registration-time metadata on a module. Feeds static analysis, Flow
 * hints, and the Console. Distinct from runtime `DetectedEvent.metadata`. Nothing
 * depends on it at runtime (D18).
 */
export interface EventModuleMetadata {
  description?: string;
  tags?: string[];
  owner?: string;
  /** Hints the Flow tooling uses to place this event in an Expected Flow. */
  flowHints?: Record<string, unknown>;
  deprecated?: boolean;
  relatedDocs?: string[];
}

/**
 * A registered event module (§3.4 — explicit registration only; ADR-025 declarative
 * shape). `jobs` is `JobDefinition<any>[]` rather than `JobDefinition[]` so a
 * heterogeneous list of typed jobs (each with its own `TInput`) is accepted; the
 * branded `__eventkitJob` still makes a non-job entry (`cond && job(...)`, a bare
 * function, a look-alike object) a compile error. There is no `handler` — the
 * runtime executes `jobs` directly.
 */
export interface EventModule<
  TPayload = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TPrepared extends Record<string, unknown> = Record<string, unknown>,
> {
  name: EventName;
  detector: DetectorFunction<TPayload, TMeta>;
  /**
   * Optional once-per-event data preparation merged into every job's input. Its inferred
   * return type `TPrepared` also types a per-job `input` mapper's `ctx.prepared` (D32).
   */
  prepare?: PrepareFunction<TPayload, TMeta, TPrepared>;
  /**
   * Static array of fire-and-forget jobs the runtime runs when the event is detected.
   * Each entry is a `job(fn, opts)` OR a bare job function — a bare function is sugar for
   * `job(fn)` (no options), auto-wrapped at register time with its name from `fn.name`.
   * Wrap in `job()` only when you need `{ name, retries, input, timeoutMs, … }`. This does
   * NOT reopen the conditional-inclusion hole (ADR-025): `cond && fn` is `false | JobFunction`
   * and `cond && job(fn)` is `false | JobDefinition` — `false` is assignable to neither, so
   * both still fail to compile; `null`/non-job objects are rejected too. Required in
   * effect: a module with no jobs does nothing (a register error) — the HTTP reply is
   * NOT a module concern (it lives on `kit.handler({ after })`).
   */
  jobs?: (JobDefinition<any> | JobFunction<any>)[];
  /** Run options for this module's job set (defaults pinned: parallel + continue). */
  run?: RunOptions;
  metadata?: EventModuleMetadata;
}

/**
 * The module shape a SOURCE-SCOPED `defineEvent` accepts — e.g.
 * `hasuraEvent.defineEvent<Row>({ ... })`. Same fields as `EventModule`, but every
 * seam is typed by the SOURCE's enriched contexts instead of the generic base
 * ones, so ONE type parameter on the outer call types every inline `(ctx) => ...`
 * arrow (`detector`, `prepare`) with no per-seam helper
 * wrapper. Each source declares its `defineEvent` with its own detector/handler
 * context types; the runtime is core `defineEvent` unchanged.
 *
 * TPrepared caveat (TS has no partial inference): when the caller passes the
 * source type parameter explicitly, `TPrepared` falls back to its default — a
 * per-job `input` mapper then sees `ctx.prepared` as `Record<string, unknown>`
 * unless the caller states it too. Full inference (the helper style) keeps D32.
 */
export interface SourceEventModule<
  TDetectorCtx,
  THandlerCtx,
  TPrepared extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  detector: (ctx: TDetectorCtx) => boolean | Promise<boolean>;
  prepare?: (ctx: THandlerCtx) => TPrepared | Promise<TPrepared>;
  jobs?: (JobDefinition<any> | JobFunction<any>)[];
  run?: RunOptions;
  metadata?: EventModuleMetadata;
}

/**
 * Typed identity helper for authoring a module (same pattern as the source
 * `.detector` helpers) — improves inference and gives one obvious construction
 * site. `defineEvent({ ... })` returns its argument unchanged; the `name` is
 * branded for ergonomics so authors pass a plain string.
 */
export function defineEvent<
  TPayload = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TPrepared extends Record<string, unknown> = Record<string, unknown>,
>(
  module: Omit<EventModule<TPayload, TMeta, TPrepared>, 'name'> & { name: string },
): EventModule<TPayload, TMeta, TPrepared> {
  // TPrepared is inferred from `prepare`'s return type (D32) and threaded into a
  // per-job `input` mapper's `ctx.prepared`, so that seam is typed without restatement.
  return { ...module, name: asEventName(module.name) };
}
