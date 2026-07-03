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
export { recordingPlugin, memorySink, type RecordingPlugin, type MemorySink } from './instruments.js';

// Payload builders (ADR-036) — construct the raw payload each source expects.
export {
  hasuraInsert,
  hasuraUpdate,
  hasuraManualEdit,
  hasuraDelete,
  hasuraCronPayload,
  hasuraActionPayload,
  webhookRequest,
  isWebhookRequest,
  type HasuraEventOptions,
  type WebhookRequestInit,
  type BuiltWebhookRequest,
} from './builders.js';

// Recording harness + doubles + assertions (ADR-036).
export {
  testInvocation,
  detectorContract,
  memoryBatchStore,
  capturedLogger,
  simulateChain,
  expectFlow,
  observedFlowNodes,
  assertObservedWithinFlow,
  type TestInvocationResult,
  type DetectorContractCases,
  type DetectorContractReport,
  type MemoryBatchStore,
  type CapturedLogger,
  type CapturedLogEntry,
  type SimulateChainResult,
  type FlowEventAssertion,
  type FlowAssertion,
  type ObservedFlowComparison,
} from './harness.js';

// Event-name ↔ filename validator (ADR-025 convention check).
export {
  findEventNameMismatches,
  assertEventNamesMatchFilenames,
  type EventNameMismatch,
  type ValidateEventNamesOptions,
} from './validate-event-names.js';
