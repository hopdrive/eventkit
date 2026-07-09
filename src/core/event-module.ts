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
// Request/response sources (ADR-026 — `hasuraAction`, status-contract `webhook`) add an
// optional `response` DECLARATION: one field, three self-naming modes, each stating at
// the definition site what the reply derives from (and therefore when it runs):
//   response: { static: {…} }          — a constant; the work cannot change it
//   response: { fromRequest: (ctx) => …} — computed from the request; runs alongside jobs
//   response: { fromJobs: (ctx, {jobs, ok}) => …} — computed from the results; runs after
// The single field makes the modes structurally exclusive; the source's platform adapter
// maps the produced value to the wire. Fire-and-forget stays the default: declare no
// `response` and the platform returns its standard ack once jobs finish.

import { asEventName, type EventName } from './brands.js';
import type { DetectorContext, HandlerContext } from './context.js';
import type { JobDefinition, JobFunction, JobInputContext, JobsResult, RunOptions } from './job.js';

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
 * A JSON-representable response body for the `static` mode. A `Promise` (or any
 * class instance) is deliberately NOT assignable — a static reply is data, not code,
 * so it provably cannot wait on or depend on the work.
 */
export type ResponseBody = string | number | boolean | null | { [key: string]: unknown } | unknown[];

/**
 * The module's RESPONSE declaration (ADR-026, amended): one field, three self-naming
 * modes. The key at the definition site states the behavioral contract — what the
 * reply derives from, and therefore when it runs — so a later maintainer reads it
 * without opening the function:
 *
 *  - `{ static: body }` — Computed: from NOTHING; it is a constant. Data, not code,
 *    so it provably cannot wait on or be changed by the work (job failures are
 *    Batch/observability's concern, never the vendor's).
 *  - `{ fromRequest: (ctx) => body }` — Computed: from the REQUEST (handler ctx plus
 *    `ctx.prepared`), alongside the jobs; it can never see their results (the context
 *    doesn't carry them). Doing the work in here is legitimate — a throw maps to the
 *    vendor's error status (`ClientError`/`ActionError`), so the vendor's redelivery
 *    becomes the retry.
 *  - `{ fromJobs: (ctx, { jobs, ok }) => body }` — Computed: from the JOBS' OUTCOMES,
 *    after they settle. Requires at least one job.
 *
 *  Sent: in every mode, the PLATFORM sends the reply — a foreground function replies
 *  once the whole run settles (a serverless function cannot reply and keep working);
 *  a background platform acks 202 up-front, which is why `{ fromJobs }` is rejected
 *  there at `validate()`. The modes declare what the reply DERIVES FROM — never when
 *  the wire is written.
 *
 *  Exactly one mode may be declared — the single field plus the `never`-typed
 *  cross-keys make that a compile error, and register time enforces it for JS.
 */
export type ResponseDeclaration<TCtx = any, TResult = unknown> =
  | { static: ResponseBody; fromRequest?: never; fromJobs?: never }
  | { fromRequest: (ctx: TCtx) => unknown; static?: never; fromJobs?: never }
  | { fromJobs: (ctx: TCtx, result: JobsResult<TResult>) => unknown; static?: never; fromRequest?: never };

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
   * return type `TPrepared` flows into the response fn's `ctx.prepared` (D32), so that
   * seams read prepared data with no restatement.
   */
  prepare?: PrepareFunction<TPayload, TMeta, TPrepared>;
  /**
   * Static array of fire-and-forget jobs the runtime runs when the event is detected.
   * Each entry is a `job(fn, opts)` OR a bare job function — a bare function is sugar for
   * `job(fn)` (no options), auto-wrapped at register time with its name from `fn.name`.
   * Wrap in `job()` only when you need `{ name, retries, input, timeoutMs, … }`. This does
   * NOT reopen the conditional-inclusion hole (ADR-025): `cond && fn` is `false | JobFunction`
   * and `cond && job(fn)` is `false | JobDefinition` — `false` is assignable to neither, so
   * both still fail to compile; `null`/non-job objects are rejected too. Optional: a
   * request/response module (with a `response`) may declare none, but a module MUST declare
   * `jobs` and/or a `response` (a do-nothing module is a register error).
   */
  jobs?: (JobDefinition<any> | JobFunction<any>)[];
  /**
   * The response declaration (ADR-026, amended): `{ static }`, `{ fromRequest }`, or
   * `{ fromJobs }` — see {@link ResponseDeclaration} for the three contracts. Optional
   * and source-agnostic; the source's platform adapter maps the produced value to the
   * wire. Omit it for fire-and-forget (the platform returns its standard ack).
   */
  response?: ResponseDeclaration<JobInputContext<TPayload, TMeta, TPrepared>>;
  /** Run options for this module's job set (defaults pinned: parallel + continue). */
  run?: RunOptions;
  metadata?: EventModuleMetadata;
}

/**
 * The module shape a SOURCE-SCOPED `defineEvent` accepts — e.g.
 * `hasuraEvent.defineEvent<Row>({ ... })`. Same fields as `EventModule`, but every
 * seam is typed by the SOURCE's enriched contexts instead of the generic base
 * ones, so ONE type parameter on the outer call types every inline `(ctx) => ...`
 * arrow (`detector`, `prepare`, the `response` fns) with no per-seam helper
 * wrapper. Each source declares its `defineEvent` with its own detector/handler
 * context types; the runtime is core `defineEvent` unchanged.
 *
 * TPrepared caveat (TS has no partial inference): when the caller passes the
 * source type parameter explicitly, `TPrepared` falls back to its default —
 * the `response` fns then see `ctx.prepared` as `Record<string, unknown>` unless
 * the caller states it too. Full inference (the helper-wrapper style) keeps D32.
 */
export interface SourceEventModule<
  TDetectorCtx,
  THandlerCtx,
  TPrepared extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  detector: (ctx: TDetectorCtx) => boolean | Promise<boolean>;
  prepare?: (ctx: THandlerCtx) => TPrepared | Promise<TPrepared>;
  /** The response declaration — see {@link ResponseDeclaration}; the fn modes receive the source-typed handler ctx plus `prepared`. */
  response?: ResponseDeclaration<THandlerCtx & { prepared: TPrepared }>;
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
  // TPrepared is inferred from `prepare`'s return type (D32) and threaded into
  // the response fn's `ctx.prepared`, so that seam is typed without restatement.
  return { ...module, name: asEventName(module.name) };
}
