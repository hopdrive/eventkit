// =============================================================================
// @hopdrive/eventkit/testing
// =============================================================================
// Test helpers for exercising detectors, handlers, jobs, and plugins without a
// real source/platform (§20). `fakeSource` is a minimal in-memory SourceAdapter:
// it wraps any payload in an EventEnvelope and exposes it as `ctx.payload` on both
// the detector and handler contexts.

import {
  asCorrelationId,
  asEventName,
  asEventSourceName,
  type CorrelationId,
  type DetectedEvent,
  type DetectorContext,
  type DetectorFunction,
  type EventEnvelope,
  type EventKitPlugin,
  type EventModule,
  type HandlerContext,
  type HandlerFunction,
  type RequestContext,
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
  handler<TPayload = unknown>(
    fn: (event: DetectedEvent<TPayload>, ctx: FakeHandlerContext<TPayload>) => ReturnType<HandlerFunction>,
  ): HandlerFunction<TPayload>;
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
    handler(fn) {
      return fn as unknown as HandlerFunction;
    },
  };
}

/** Convenience: assemble an EventModule from a name + detector + handler. */
export function defineFakeEvent<TPayload = unknown>(
  name: string,
  detector: (ctx: FakeDetectorContext<TPayload>) => boolean | Promise<boolean>,
  handler: (event: DetectedEvent<TPayload>, ctx: FakeHandlerContext<TPayload>) => ReturnType<HandlerFunction>,
): EventModule<TPayload> {
  return {
    name: asEventName(name),
    detector: detector as unknown as EventModule<TPayload>['detector'],
    handler: handler as unknown as EventModule<TPayload>['handler'],
  };
}
