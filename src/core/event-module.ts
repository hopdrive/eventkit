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
// optional `resolve(ctx) => output` that computes the invocation's response value; the
// source's platform adapter maps it to the wire. `jobs` then become optional side
// effects that run alongside (sibling-ignorant — `resolve` never reads their results).

import { asEventName, type EventName } from './brands.js';
import type { DetectorContext, HandlerContext } from './context.js';
import type { JobDefinition, JobInputContext, RunOptions } from './job.js';

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
 * Computes the invocation's RESPONSE value for a request/response source (ADR-026 —
 * `hasuraAction`, a status-contract `webhook`). Receives the handler context plus the
 * `prepare` output (`ctx.prepared`); the source's platform adapter maps the returned
 * value to the wire (a 2xx body) and a thrown `ClientError`/`ActionError` to the error
 * envelope. `resolve` is the module composing the response — it MUST NOT read job
 * results (jobs are sibling-ignorant fire-and-forget side effects, ADR-025). Optional
 * and source-agnostic: a fire-and-forget module omits it and just returns an ack.
 */
export type ResolveFunction<
  TPayload = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
  TPrepared = Record<string, unknown>,
  TOutput = unknown,
> = (ctx: JobInputContext<TPayload, TMeta, TPrepared>) => TOutput | Promise<TOutput>;

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
> {
  name: EventName;
  detector: DetectorFunction<TPayload, TMeta>;
  /** Optional once-per-event data preparation merged into every job's input. */
  prepare?: PrepareFunction<TPayload, TMeta>;
  /**
   * Static array of fire-and-forget jobs the runtime runs when the event is detected.
   * Optional: a request/response module (with `resolve`) may declare none. A module
   * MUST declare `jobs` and/or `resolve` (a do-nothing module is a register error).
   */
  jobs?: JobDefinition<any>[];
  /**
   * Request/response seam (ADR-026): computes the invocation's response value. Optional
   * and source-agnostic; the source's platform adapter maps it to the wire. Jobs (if any)
   * run alongside as sibling-ignorant side effects — `resolve` never reads their results.
   */
  resolve?: ResolveFunction<TPayload, TMeta>;
  /** Run options for this module's job set (defaults pinned: parallel + continue). */
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
>(module: Omit<EventModule<TPayload, TMeta>, 'name'> & { name: string }): EventModule<TPayload, TMeta> {
  return { ...module, name: asEventName(module.name) };
}
