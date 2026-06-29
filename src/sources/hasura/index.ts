// =============================================================================
// @hopdrive/eventkit/sources/hasura
// =============================================================================
// Two Hasura-origin source adapters, named by transport (ADR-023):
//   hasuraEvent — DB event triggers
//   hasuraCron  — Hasura scheduled triggers
//
// Phase 0 freezes the authoring surface and the types. The `.detector`/`.handler`
// authoring helpers are real (identity wrappers that carry types); the Shape-3
// capability methods (normalize/buildDetectorContext/buildHandlerContext) are
// stubbed until Phase 2.

import type {
  DetectorContext,
  DetectorFunction,
  HandlerContext,
  HandlerFunction,
  DetectedEvent,
  EventKitPlugin,
  EventEnvelope,
  EventSourceType,
  RequestContext,
} from '../../core/index.js';
import type {
  HasuraEventPayload,
  HasuraCronPayload,
  HasuraDetectorContext,
  HasuraHandlerContext,
  HasuraCronContext,
  HasuraCronHandlerContext,
} from './types.js';
import {
  normalizeHasuraEvent,
  buildHasuraDetectorContext,
  buildHasuraHandlerContext,
  normalizeHasuraCron,
  buildHasuraCronDetectorContext,
  buildHasuraCronHandlerContext,
} from './adapter.js';

export type * from './types.js';
export {
  columnChanged,
  columnAdded,
  columnRemoved,
  getOperation,
  getOldRow,
  getNewRow,
  getSession,
} from './payload.js';

/** The `hasuraEvent` source adapter plus its authoring helpers. */
export interface HasuraEventSource extends EventKitPlugin {
  sourceType: EventSourceType;
  detector<TNewRow = Record<string, unknown>, TOldRow = TNewRow>(
    fn: (ctx: HasuraDetectorContext<TNewRow, TOldRow>) => boolean | Promise<boolean>,
  ): DetectorFunction<HasuraEventPayload<TNewRow, TOldRow>>;
  handler<TNewRow = Record<string, unknown>, TOldRow = TNewRow>(
    fn: (
      event: DetectedEvent<HasuraEventPayload<TNewRow, TOldRow>>,
      ctx: HasuraHandlerContext<TNewRow, TOldRow>,
    ) => ReturnType<HandlerFunction>,
  ): HandlerFunction<HasuraEventPayload<TNewRow, TOldRow>>;
}

/** The `hasuraCron` source adapter plus its authoring helpers. */
export interface HasuraCronSource extends EventKitPlugin {
  sourceType: EventSourceType;
  detector<TPayload = Record<string, unknown>>(
    fn: (ctx: HasuraCronContext<TPayload>) => boolean | Promise<boolean>,
  ): DetectorFunction<HasuraCronPayload<TPayload>>;
  handler<TPayload = Record<string, unknown>>(
    fn: (
      event: DetectedEvent<HasuraCronPayload<TPayload>>,
      ctx: HasuraCronHandlerContext<TPayload>,
    ) => ReturnType<HandlerFunction>,
  ): HandlerFunction<HasuraCronPayload<TPayload>>;
}

export const hasuraEvent: HasuraEventSource = {
  name: 'hasura',
  provides: ['source', 'source:hasura'],
  sourceType: 'database',
  // Authoring helpers — identity wrappers; the runtime supplies the enriched ctx.
  detector(fn) {
    return fn as unknown as DetectorFunction;
  },
  handler(fn) {
    return fn as unknown as HandlerFunction;
  },
  // Shape-3 capabilities.
  normalize(raw: unknown, request: RequestContext): EventEnvelope {
    return normalizeHasuraEvent(raw, request) as EventEnvelope;
  },
  buildDetectorContext(envelope: EventEnvelope, base: DetectorContext): HasuraDetectorContext {
    return buildHasuraDetectorContext(envelope as EventEnvelope<HasuraEventPayload>, base as DetectorContext<HasuraEventPayload>);
  },
  buildHandlerContext(envelope: EventEnvelope, base: HandlerContext) {
    return buildHasuraHandlerContext(envelope as EventEnvelope<HasuraEventPayload>, base as HandlerContext<HasuraEventPayload>);
  },
};

export const hasuraCron: HasuraCronSource = {
  name: 'hasura-cron',
  provides: ['source', 'source:hasura-cron'],
  sourceType: 'cron',
  detector(fn) {
    return fn as unknown as DetectorFunction;
  },
  handler(fn) {
    return fn as unknown as HandlerFunction;
  },
  normalize(raw: unknown, request: RequestContext): EventEnvelope {
    return normalizeHasuraCron(raw, request) as EventEnvelope;
  },
  buildDetectorContext(envelope: EventEnvelope, base: DetectorContext): HasuraCronContext {
    return buildHasuraCronDetectorContext(envelope as EventEnvelope<HasuraCronPayload>, base as DetectorContext<HasuraCronPayload>);
  },
  buildHandlerContext(envelope: EventEnvelope, base: HandlerContext) {
    return buildHasuraCronHandlerContext(envelope as EventEnvelope<HasuraCronPayload>, base as HandlerContext<HasuraCronPayload>);
  },
};
