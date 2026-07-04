// =============================================================================
// Contexts (§9.2, §9.7)
// =============================================================================
// DetectorContext  — detection only; source helpers hang off `sourceContext`.
// HandlerContext   — after detection; source MAY extend it with DATA (no helpers).
// RequestContext   — per-request config handed to `handle()`.
// InvocationContext — per-invocation context the runtime threads to every plugin.
// KitContext       — kit-level context injected into a plugin at `onInit`.

import type { EventName, EventSourceName, InvocationId, CorrelationId } from './brands.js';
import type { EventSourceType, EventEnvelope, DetectedEvent } from './envelope.js';
import type { DetectorLogger, HandlerLogger } from './logger.js';

/**
 * Context passed to a detector. The generic *base* the runtime builds; a source
 * adapter ENRICHES it by intersection in `buildDetectorContext` — the source's
 * helpers (Hasura: `operation`/`columnChanged()`/rows) are flattened directly
 * onto the context the authored detector receives (see `HasuraDetectorContext`).
 * There is intentionally no `sourceContext` sub-object: flattened is the only
 * style, so a contributor reaches for `ctx.operation`, never `ctx.sourceContext`.
 * Detection-only; SHOULD be pure over this context (§8).
 */
export interface DetectorContext<
  TPayload = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  eventName: EventName;
  invocationId: InvocationId;
  correlationId: CorrelationId;
  envelope: EventEnvelope<TPayload, TMeta>;
  source: EventSourceName;
  sourceType: EventSourceType;
  log: DetectorLogger;
  metadata: Record<string, unknown>;
  /**
   * Request-scoped shared refs contributed by the kit-level `prepare`
   * (`createEventKit(source, { prepare })`). `{}` when no kit `prepare` is configured.
   * The SAME object appears on the detector, module `prepare`, and job contexts of an
   * invocation. Never serialized — safe for live objects (an executor, a vendor client).
   */
  provided: Record<string, unknown>;
}

/**
 * Context passed to a handler after detection. Generic base; a source MAY extend
 * it with typed DATA via `buildHandlerContext` (never detection helpers, §7).
 */
export interface HandlerContext<
  TPayload = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  invocationId: InvocationId;
  correlationId: CorrelationId;
  event: DetectedEvent<TPayload, TMeta>;
  envelope: EventEnvelope<TPayload, TMeta>;
  source: EventSourceName;
  sourceType: EventSourceType;
  log: HandlerLogger;
  metadata: Record<string, unknown>;
  signal?: AbortSignal;
  /** Kit-level `prepare` output; see {@link DetectorContext.provided}. `{}` if none. */
  provided: Record<string, unknown>;
}

/**
 * Per-request input to `kit.handle()`. Normally produced by a PlatformAdapter's
 * `buildRequest`; supplied by hand only for custom runtimes/tests (§9.8).
 */
export interface RequestContext {
  /** Override; the runtime generates one if absent. */
  invocationId?: string;
  /** Else derived from the source (e.g. Hasura `trace_context`) or generated. */
  correlationId?: string;
  /** e.g. `'db-moves'` — client name + observability attribution. */
  sourceFunction?: string;
  /** Serverless time budget. Normally supplied by the platform adapter (§9.8). */
  getRemainingTimeMs?: () => number;
  /** Per-request plugin overrides, keyed by plugin name. */
  pluginConfig?: Record<string, Record<string, unknown>>;
  meta?: Record<string, unknown>;
}

/**
 * Per-invocation context threaded to every plugin hook. Per-request config
 * reaches plugins here, eliminating per-invocation `register(...)` (ADR-013).
 */
export interface InvocationContext<
  TPayload = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  invocationId: InvocationId;
  correlationId: CorrelationId;
  sourceFunction?: string;
  source: EventSourceName;
  sourceType: EventSourceType;
  envelope: EventEnvelope<TPayload, TMeta>;
  request: RequestContext;
  startedAt: Date;
  signal: AbortSignal;
  log: HandlerLogger;
  /**
   * Kit-level `prepare` output for this invocation (see {@link DetectorContext.provided}).
   * Computed once after normalize / before detection; `{}` if no kit `prepare` is set.
   */
  provided: Record<string, unknown>;
}

/**
 * Context handed to a kit-level `prepare` — `createEventKit(source, { prepare })`. It runs
 * ONCE per invocation, AFTER normalize and BEFORE detection, and its returned object becomes
 * `ctx.provided` for every detector, module `prepare`, and job of that invocation. Use it to
 * build request-scoped shared refs (a GraphQL executor, a vendor client, a resolved config)
 * in ONE place instead of a hand-rolled `augmentJobContext` plugin. Request-scoped and NEVER
 * serialized (unlike `envelope.meta`), so live objects are fine here. Keep it cheap — it also
 * runs in `dryRun` so detectors that read `ctx.provided` behave identically.
 */
export interface KitPrepareContext<
  TPayload = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  invocationId: InvocationId;
  correlationId: CorrelationId;
  envelope: EventEnvelope<TPayload, TMeta>;
  source: EventSourceName;
  sourceType: EventSourceType;
  log: HandlerLogger;
  signal: AbortSignal;
}

/** A kit-level `prepare` function (see {@link KitPrepareContext}). */
export type KitPrepareFunction = (
  ctx: KitPrepareContext,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

/**
 * Kit-level context injected into a plugin when it is instantiated. Per the
 * resolved default for D22, instantiation is LAZY (at `validate()`/first
 * `handle()`), so the resolved source/platform and the kit logger are available
 * to the plugin's constructor and its `requires` checks can run once everything
 * is registered.
 */
export interface KitContext {
  /** The resolved source for this kit. */
  source: { name: EventSourceName; sourceType: EventSourceType };
  /** The resolved platform, if one was registered. */
  platform?: { name: string };
  /** Names of every plugin registered on the kit, in registration order. */
  registeredPlugins: string[];
  /** Kit-level logger. */
  log: HandlerLogger;
  /** This plugin's resolved config (merged kit + per-request defaults). */
  config: Record<string, unknown>;
}
