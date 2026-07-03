// =============================================================================
// Plugin composition model (§11, ADR-022)
// =============================================================================
// Every hook is exactly one of three shapes:
//   Shape 1 — Notification (`onX`, void): observe; fans out in registration order.
//             Spans use Start/End; capability brackets use Before/After;
//             self-lifecycle is onInit/onFlush/onShutdown.
//   Shape 2 — Delta transform (bare verb → partial; runtime merges over a base).
//             The default always contributes; plugins only add ("default + extra").
//   Shape 3 — Singleton capability (bare verb; exactly one provider via `provides`).
//             The only shape where replacement is possible; the default is injected
//             as a `base` argument (DI, never inheritance).
// Naming rule: `on…` = void notification; a bare verb returns a value.

import type { Capability } from './capabilities.js';
import type { EventName } from './brands.js';
import type {
  DetectorContext,
  HandlerContext,
  InvocationContext,
  KitContext,
  RequestContext,
} from './context.js';
import type { EventEnvelope } from './envelope.js';
import type { JobContext, JobContextContribution, JobProgress, JobCheckpoint, JobExecution } from './job.js';
import type { LogEntry } from './logger.js';
import type { SerializedError, ErrorContext } from './errors.js';
import type { InvocationResult, HandlerShortCircuit } from './kit.js';

/** Result handed to `onEventDetectionEnd`. */
export interface DetectionResult {
  eventName: EventName;
  detected: boolean;
  durationMs: number;
  error?: SerializedError;
}

/** Result handed to `onEventHandlerEnd`. */
export interface HandlerResult {
  eventName: EventName;
  jobs: JobExecution[];
  durationMs: number;
  error?: SerializedError;
}

/** The default `normalize`, injected as `base` so a replacement can reuse it. */
export type NormalizeFn = (raw: unknown, request: RequestContext) => EventEnvelope;

/** The default `formatResponse`, injected as `base` so a replacement can reuse it. */
export type FormatFn = (result: InvocationResult) => unknown;

/**
 * The unifying plugin contract. A SourceAdapter is a plugin whose distinguishing
 * hooks are the Shape-3 capabilities `normalize`/`buildDetectorContext`/
 * `buildHandlerContext` (`provides: ['source']`); a PlatformAdapter is one whose
 * distinguishing hooks are `extractPayload`/`buildRequest`/`formatResponse`
 * (`provides: ['platform']`). Both reuse this same backbone (§11.2).
 */
export interface EventKitPlugin {
  name: string;
  /** Singleton roles this plugin fills (uniqueness enforced at the role level). */
  provides?: Capability[];
  /** Singleton roles this plugin depends on (validated at `onInit`). */
  requires?: Capability[];

  // ── Shape 1: notifications (void) ──────────────────────────────────────
  onInit?(ctx: KitContext): Promise<void> | void;
  onInvocationStart?(ctx: InvocationContext): Promise<void> | void;
  onInvocationEnd?(ctx: InvocationContext, result: InvocationResult): Promise<void> | void;
  onEventDetectionStart?(ctx: DetectorContext): Promise<void> | void;
  onEventDetectionEnd?(ctx: DetectorContext, result: DetectionResult): Promise<void> | void;
  onEventHandlerStart?(ctx: HandlerContext): Promise<void> | void;
  onEventHandlerEnd?(ctx: HandlerContext, result: HandlerResult): Promise<void> | void;
  onJobStart?(ctx: JobContext): Promise<void> | void;
  onJobProgress?(ctx: JobContext, progress: JobProgress): Promise<void> | void;
  onJobCheckpoint?(ctx: JobContext, checkpoint: JobCheckpoint): Promise<void> | void;
  onJobLog?(ctx: JobContext, entry: LogEntry): Promise<void> | void;
  onJobEnd?(ctx: JobContext, execution: JobExecution): Promise<void> | void;
  /** Framework-level logs (detection, runtime, timeout) — preserves `onLog` breadth (§9.3). */
  onLog?(entry: LogEntry): Promise<void> | void;
  onError?(ctx: ErrorContext): Promise<void> | void;
  onBeforeNormalize?(raw: unknown, request: RequestContext): Promise<void> | void;
  onAfterNormalize?(envelope: EventEnvelope): Promise<void> | void;
  onFlush?(): Promise<void> | void;
  onShutdown?(): Promise<void> | void;

  // ── Shape 2: delta transforms (return a partial; runtime merges) ────────
  configureInvocation?(request: RequestContext, envelope: EventEnvelope): Partial<RequestContext> | void;
  /**
   * Contribute a partial envelope before the correlation id locks. MAY be async: the
   * runtime awaits each plugin's return in registration order, so a sync extractor
   * (loop-guard) and an async resolver (correlation-resolver, which does a DB lookup
   * across an external vendor round-trip — ADR-028) share this one seam.
   */
  augmentEnvelope?(envelope: EventEnvelope): Partial<EventEnvelope> | void | Promise<Partial<EventEnvelope> | void>;
  augmentJobContext?(ctx: JobContext): JobContextContribution | void;

  // ── Shape 3: singleton capabilities (one provider; `base` = injected default) ──
  normalize?(raw: unknown, request: RequestContext, base?: NormalizeFn): EventEnvelope;
  buildDetectorContext?(envelope: EventEnvelope, base: DetectorContext): unknown;
  buildHandlerContext?(envelope: EventEnvelope, base: HandlerContext): unknown;
  extractPayload?(...args: unknown[]): unknown | Promise<unknown>;
  buildRequest?(...args: unknown[]): RequestContext;
  formatResponse?(result: InvocationResult, base?: FormatFn): unknown;
  /** Shape a pre-handle short-circuit (e.g. an auth rejection from `handler({ before })`) into the platform's response. */
  formatRejection?(rejection: HandlerShortCircuit): unknown;
  /** Platform answers before jobs finish (background/202-early); see `PlatformAdapter.deferredResponse`. */
  deferredResponse?: boolean;
  /**
   * How the framework treats an unhandled PROCESSING crash (a detector or `prepare`
   * throw — not a `resolve`/`respond` throw, which is a deliberate reply). A SOURCE may
   * declare this to pick the retry contract that suits its transport (ADR-038):
   *   - `'ack'` (framework default): the crash stays in `events[].error`, the invocation
   *      still returns 200, and the transport does NOT retry. Right for Hasura event
   *      triggers, where a poison row must not retry forever.
   *   - `'signalRetry'`: the crash is escalated to a top-level `result.error` → 500, so
   *      an at-least-once sender (a vendor webhook) retries. A `resolve`/`respond`
   *      response, if one was produced, still wins (that reply is intentional).
   * The webhook source defaults to `'signalRetry'`.
   */
  crashPolicy?: CrashPolicy;
}

/**
 * How a source wants an unhandled detector/`prepare` crash to map to the transport's
 * retry contract (ADR-038). See `EventKitPlugin.crashPolicy`.
 */
export type CrashPolicy = 'ack' | 'signalRetry';

/**
 * A source adapter (§7). The distinguishing Shape-3 capabilities of a `'source'`
 * plugin, expressed as a focused contract for authoring. `THandlerExt` is the
 * typed DATA the source contributes to the handler context (never helpers).
 */
export interface SourceAdapter<
  TPayload = unknown,
  TDetectorCtx = unknown,
  THandlerExt extends Record<string, unknown> = Record<string, never>,
> extends EventKitPlugin {
  sourceType: EventEnvelope<TPayload>['sourceType'];
  normalize(raw: unknown, request: RequestContext): EventEnvelope<TPayload>;
  buildDetectorContext(envelope: EventEnvelope<TPayload>, base: DetectorContext<TPayload>): TDetectorCtx;
  buildHandlerContext?(envelope: EventEnvelope<TPayload>, base: HandlerContext<TPayload>): THandlerExt;
}

/**
 * A platform adapter (§9.8, ADR-021). Normalizes a deployment runtime's
 * invocation: how the request arrives, how long we may run, and what response
 * shape it expects back. Optional and registered like any capability via
 * `kit.use(netlifyPlatform)`.
 */
export interface PlatformAdapter<TArgs extends unknown[] = unknown[], TResponse = unknown>
  extends EventKitPlugin {
  /** True if this adapter matches the current runtime (env-based). */
  detect?(): boolean;
  /**
   * True if this adapter returns its response BEFORE jobs finish (a background / 202-early
   * runtime). The kit rejects a result-driven `respond` module on such a platform at
   * `validate()` time, since the response can't reflect job outcomes that haven't happened.
   */
  deferredResponse?: boolean;
  extractPayload(...args: TArgs): unknown | Promise<unknown>;
  buildRequest(...args: TArgs): RequestContext;
  formatResponse(result: InvocationResult): TResponse;
  /** Shape a pre-handle short-circuit (auth/method rejection) into this platform's response. */
  formatRejection(rejection: HandlerShortCircuit): TResponse;
}
