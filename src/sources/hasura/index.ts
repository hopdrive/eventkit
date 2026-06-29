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
  DetectorFunction,
  HandlerFunction,
  DetectedEvent,
  EventKitPlugin,
  EventEnvelope,
  EventSourceType,
  RequestContext,
} from '../../core/index.js';
import { NotImplementedError } from '../../core/index.js';
import type {
  HasuraEventPayload,
  HasuraCronPayload,
  HasuraDetectorContext,
  HasuraHandlerContext,
  HasuraCronContext,
} from './types.js';

export type * from './types.js';

const notImpl = (what: string): never => {
  throw new NotImplementedError(`${what} — Hasura source runtime lands in Phase 2.`);
};

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
      ctx: HasuraCronContext<TPayload>,
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
  // Shape-3 capability — Phase 2.
  normalize(_raw: unknown, _request: RequestContext): EventEnvelope {
    return notImpl('hasuraEvent.normalize');
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
  normalize(_raw: unknown, _request: RequestContext): EventEnvelope {
    return notImpl('hasuraCron.normalize');
  },
};
