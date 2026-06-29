// =============================================================================
// @hopdrive/eventkit/sources/hasura
// =============================================================================
// Two Hasura-origin source adapters, named by transport (ADR-023):
//   hasuraEvent — DB event triggers
//   hasuraCron  — Hasura scheduled triggers
//
// Authoring helpers (ADR-025): `.detector` carries the source's enriched detector
// context, and `.prepare` carries the source's handler context for a module's
// once-before-jobs data prep. There is no `.handler` — a module declares a static
// `jobs` array (see `defineEvent`) the runtime executes. The Shape-3 capability
// methods (normalize/buildDetectorContext/buildHandlerContext) do the real work.

import type {
  DetectorContext,
  DetectorFunction,
  HandlerContext,
  PrepareFunction,
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
  prepare<TNewRow = Record<string, unknown>, TOldRow = TNewRow, TPrepared extends Record<string, unknown> = Record<string, unknown>>(
    fn: (ctx: HasuraHandlerContext<TNewRow, TOldRow>) => TPrepared | Promise<TPrepared>,
  ): PrepareFunction<HasuraEventPayload<TNewRow, TOldRow>>;
}

/** The `hasuraCron` source adapter plus its authoring helpers. */
export interface HasuraCronSource extends EventKitPlugin {
  sourceType: EventSourceType;
  detector<TPayload = Record<string, unknown>>(
    fn: (ctx: HasuraCronContext<TPayload>) => boolean | Promise<boolean>,
  ): DetectorFunction<HasuraCronPayload<TPayload>>;
  prepare<TPayload = Record<string, unknown>, TPrepared extends Record<string, unknown> = Record<string, unknown>>(
    fn: (ctx: HasuraCronHandlerContext<TPayload>) => TPrepared | Promise<TPrepared>,
  ): PrepareFunction<HasuraCronPayload<TPayload>>;
}

export const hasuraEvent: HasuraEventSource = {
  name: 'hasura',
  provides: ['source', 'source:hasura'],
  sourceType: 'database',
  // Authoring helpers — identity wrappers; the runtime supplies the enriched ctx.
  detector(fn) {
    return fn as unknown as DetectorFunction;
  },
  prepare(fn) {
    return fn as unknown as PrepareFunction;
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
  prepare(fn) {
    return fn as unknown as PrepareFunction;
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
