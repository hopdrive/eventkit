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
import type { JobContext, JobProgress, JobCheckpoint, JobExecution } from './job.js';
import type { LogEntry } from './logger.js';
import type { SerializedError, ErrorContext } from './errors.js';
import type { InvocationResult } from './kit.js';

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
  augmentEnvelope?(envelope: EventEnvelope): Partial<EventEnvelope> | void;
  augmentJobContext?(
    ctx: JobContext,
  ): { input?: Record<string, unknown>; context?: Record<string, unknown> } | void;

  // ── Shape 3: singleton capabilities (one provider; `base` = injected default) ──
  normalize?(raw: unknown, request: RequestContext, base?: NormalizeFn): EventEnvelope;
  buildDetectorContext?(envelope: EventEnvelope, base: DetectorContext): unknown;
  buildHandlerContext?(envelope: EventEnvelope, base: HandlerContext): unknown;
  extractPayload?(...args: unknown[]): unknown | Promise<unknown>;
  buildRequest?(...args: unknown[]): RequestContext;
  formatResponse?(result: InvocationResult, base?: FormatFn): unknown;
}

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
  extractPayload(...args: TArgs): unknown | Promise<unknown>;
  buildRequest(...args: TArgs): RequestContext;
  formatResponse(result: InvocationResult): TResponse;
}
