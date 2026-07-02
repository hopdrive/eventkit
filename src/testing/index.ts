// =============================================================================
// @hopdrive/eventkit/testing
// =============================================================================
// Test helpers for exercising detectors, jobs, prepare, and plugins without a real
// source/platform (§20). `fakeSource` is a minimal in-memory SourceAdapter: it wraps
// any payload in an EventEnvelope and exposes it as `ctx.payload` on both the
// detector and handler contexts.

import {
  asCorrelationId,
  asEventName,
  asEventSourceName,
  asInvocationId,
  type CorrelationId,
  type DetectedEvent,
  type DetectorContext,
  type DetectorFunction,
  type EventEnvelope,
  type EventKitPlugin,
  type EventModule,
  type HandlerContext,
  type HandlerLogger,
  type JobDefinition,
  type PrepareFunction,
  type RequestContext,
  type RunOptions,
} from '../core/index.js';
import type {
  ObservabilityBatch,
  InvocationRecord,
  EventRecord,
  JobRecord,
} from '../plugins/observability/index.js';

const randomId = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `fake-${Math.floor(Date.now()).toString(36)}-${(globalThis as { __ekc?: number }).__ekc = ((globalThis as { __ekc?: number }).__ekc ?? 0) + 1}`;

/** Detector context the fake source exposes: the base plus the raw `payload`. */
export interface FakeDetectorContext<TPayload = unknown> extends DetectorContext<TPayload> {
  payload: TPayload;
}

/** Handler context the fake source exposes: the base plus the raw `payload`. */
export interface FakeHandlerContext<TPayload = unknown> extends HandlerContext<TPayload> {
  payload: TPayload;
}

export interface FakeSource extends EventKitPlugin {
  sourceType: 'application';
  detector<TPayload = unknown>(
    fn: (ctx: FakeDetectorContext<TPayload>) => boolean | Promise<boolean>,
  ): DetectorFunction<TPayload>;
  prepare<TPayload = unknown, TPrepared extends Record<string, unknown> = Record<string, unknown>>(
    fn: (ctx: FakeHandlerContext<TPayload>) => TPrepared | Promise<TPrepared>,
  ): PrepareFunction<TPayload, Record<string, unknown>, TPrepared>;
}

/**
 * Build an in-memory fake source. Pass `correlationId` to pin one across an
 * invocation; otherwise a random id is generated per invocation.
 */
export function fakeSource(opts?: { correlationId?: string }): FakeSource {
  return {
    name: 'fake',
    provides: ['source', 'source:fake'],
    sourceType: 'application',
    normalize(raw: unknown, request: RequestContext): EventEnvelope {
      const correlationId = (request.correlationId ?? opts?.correlationId ?? randomId()) as CorrelationId;
      return {
        id: randomId(),
        source: asEventSourceName('fake'),
        sourceType: 'application',
        receivedAt: new Date(),
        correlationId: asCorrelationId(correlationId),
        payload: raw,
        meta: {},
        raw,
      };
    },
    buildDetectorContext(envelope: EventEnvelope, base: DetectorContext): FakeDetectorContext {
      return { ...base, payload: envelope.payload };
    },
    buildHandlerContext(envelope: EventEnvelope, base: HandlerContext): FakeHandlerContext {
      return { ...base, payload: envelope.payload };
    },
    detector(fn) {
      return fn as unknown as DetectorFunction;
    },
    // Generic identity wrapper preserving the inferred TPrepared into PrepareFunction (D32).
    prepare<TPayload = unknown, TPrepared extends Record<string, unknown> = Record<string, unknown>>(
      fn: (ctx: FakeHandlerContext<TPayload>) => TPrepared | Promise<TPrepared>,
    ): PrepareFunction<TPayload, Record<string, unknown>, TPrepared> {
      return fn as unknown as PrepareFunction<TPayload, Record<string, unknown>, TPrepared>;
    },
  };
}

const noopLogger: HandlerLogger = { debug() {}, info() {}, warn() {}, error() {} };

interface ContextOpts {
  eventName?: string;
  invocationId?: string;
  correlationId?: string;
}

/**
 * Build the detector context a source would produce for `raw`, so a detector can
 * be unit-tested in isolation (no kit, no handler). Works for any source that
 * implements `normalize` + `buildDetectorContext` (e.g. `hasuraEvent`).
 */
export function buildDetectorContextFor<TCtx = DetectorContext>(
  source: EventKitPlugin,
  raw: unknown,
  opts: ContextOpts = {},
): TCtx {
  if (!source.normalize) throw new Error(`Source '${source.name}' does not implement normalize().`);
  const request: RequestContext = {};
  if (opts.correlationId) request.correlationId = opts.correlationId;
  const envelope = source.normalize(raw, request);
  const base: DetectorContext = {
    eventName: asEventName(opts.eventName ?? 'test.event'),
    invocationId: asInvocationId(opts.invocationId ?? 'test-invocation'),
    correlationId: envelope.correlationId,
    envelope,
    source: envelope.source,
    sourceType: envelope.sourceType,
    log: { debug() {} },
    metadata: {},
  };
  const ctx = source.buildDetectorContext ? source.buildDetectorContext(envelope, base) : base;
  return ctx as TCtx;
}

/**
 * Build the handler context a source would produce for `raw`, so a `prepare` (or a
 * per-job `input` mapper) can be unit-tested in isolation. For a full job run use a
 * kit + `handle()`.
 */
export function buildHandlerContextFor<TCtx = HandlerContext>(
  source: EventKitPlugin,
  raw: unknown,
  opts: ContextOpts = {},
): TCtx {
  if (!source.normalize) throw new Error(`Source '${source.name}' does not implement normalize().`);
  const request: RequestContext = {};
  if (opts.correlationId) request.correlationId = opts.correlationId;
  const envelope = source.normalize(raw, request);
  const invocationId = asInvocationId(opts.invocationId ?? 'test-invocation');
  const event: DetectedEvent = {
    id: 'test-event',
    name: asEventName(opts.eventName ?? 'test.event'),
    invocationId,
    correlationId: envelope.correlationId,
    source: envelope.source,
    sourceType: envelope.sourceType,
    detectedAt: new Date(),
    detectorDurationMs: 0,
    envelope,
  };
  const base: HandlerContext = {
    invocationId,
    correlationId: envelope.correlationId,
    event,
    envelope,
    source: envelope.source,
    sourceType: envelope.sourceType,
    log: noopLogger,
    metadata: {},
  };
  const ext = source.buildHandlerContext ? source.buildHandlerContext(envelope, base) : undefined;
  return (ext ? { ...base, ...(ext as Record<string, unknown>) } : base) as TCtx;
}

/**
 * Convenience: assemble a declarative EventModule (ADR-025) from a name + detector +
 * a static `jobs` array, with optional `prepare`/`run`. Mirrors `defineEvent` but
 * types the detector/prepare against the fake source's contexts.
 */
export function defineFakeEvent<TPayload = unknown>(
  name: string,
  detector: (ctx: FakeDetectorContext<TPayload>) => boolean | Promise<boolean>,
  jobs: JobDefinition<any>[],
  opts?: {
    prepare?: (ctx: FakeHandlerContext<TPayload>) => Record<string, unknown> | Promise<Record<string, unknown>>;
    run?: RunOptions;
  },
): EventModule<TPayload> {
  const module: EventModule<TPayload> = {
    name: asEventName(name),
    detector: detector as unknown as EventModule<TPayload>['detector'],
    jobs,
  };
  if (opts?.prepare) module.prepare = opts.prepare as unknown as PrepareFunction<TPayload>;
  if (opts?.run) module.run = opts.run;
  return module;
}

// =============================================================================
// Recording instruments (ADR-036) — capture what actually happened in a real
// invocation, so tests assert against the runtime, not a mock of it.
// =============================================================================

/**
 * A recording plugin. Register it with `kit.use(rec.plugin)`; after `handle()`,
 * read the ordered hook-call log. Records every notification (`on*`) hook — never
 * transforms — so it observes without changing behavior. Powers the error-path
 * matrix and the lifecycle-ordering snapshot (§20).
 */
export interface RecordingPlugin {
  plugin: EventKitPlugin;
  /** Every notification hook fired, in order, with its raw args. */
  calls: Array<{ hook: string; args: readonly unknown[] }>;
  /** Just the hook names, in order — the lifecycle sequence to snapshot. */
  sequence(): string[];
  /** Every `onError` payload (the `ErrorContext`s the runtime routed here). */
  errors: unknown[];
  /** How many times `onFlush` ran (must be ≥1 for every invocation, incl. throws). */
  flushCount(): number;
  /** Clear the log for reuse across invocations. */
  reset(): void;
}

const NOTIFICATION_HOOKS = [
  'onInit', 'onInvocationStart', 'onInvocationEnd',
  'onEventDetectionStart', 'onEventDetectionEnd',
  'onEventHandlerStart', 'onEventHandlerEnd',
  'onJobStart', 'onJobProgress', 'onJobCheckpoint', 'onJobLog', 'onJobEnd',
  'onLog', 'onError', 'onBeforeNormalize', 'onAfterNormalize',
  'onFlush', 'onShutdown',
] as const;

export function recordingPlugin(name = 'recorder'): RecordingPlugin {
  const calls: Array<{ hook: string; args: readonly unknown[] }> = [];
  const errors: unknown[] = [];
  const plugin: Record<string, unknown> = { name };
  for (const hook of NOTIFICATION_HOOKS) {
    plugin[hook] = (...args: unknown[]) => {
      calls.push({ hook, args });
      if (hook === 'onError') errors.push(args[0]);
    };
  }
  return {
    plugin: plugin as unknown as EventKitPlugin,
    calls,
    errors,
    sequence: () => calls.map((c) => c.hook),
    flushCount: () => calls.filter((c) => c.hook === 'onFlush').length,
    reset: () => {
      calls.length = 0;
      errors.length = 0;
    },
  };
}

/**
 * An in-memory observability sink. Register it with
 * `kit.use(observability, { sink: mem })` — `mem` is callable — then read the
 * captured records. Lets a test assert the exact observability rows (the schema
 * contract with Grafana/Console) with no database (§20, golden-trace snapshots).
 */
export interface MemorySink {
  (batch: ObservabilityBatch): void;
  /** Every flushed batch, in order. */
  batches: ObservabilityBatch[];
  /** All invocation records across every batch. */
  invocations(): InvocationRecord[];
  /** All event records across every batch. */
  events(): EventRecord[];
  /** All job records across every batch. */
  jobs(): JobRecord[];
  reset(): void;
}

export function memorySink(): MemorySink {
  const batches: ObservabilityBatch[] = [];
  const sink = ((batch: ObservabilityBatch) => {
    batches.push(batch);
  }) as MemorySink;
  sink.batches = batches;
  sink.invocations = () => batches.flatMap((b) => (b.invocation ? [b.invocation] : []));
  sink.events = () => batches.flatMap((b) => b.events);
  sink.jobs = () => batches.flatMap((b) => b.jobs);
  sink.reset = () => {
    batches.length = 0;
  };
  return sink;
}

// Event-name ↔ filename validator (ADR-025 convention check).
export {
  findEventNameMismatches,
  assertEventNamesMatchFilenames,
  type EventNameMismatch,
  type ValidateEventNamesOptions,
} from './validate-event-names.js';
