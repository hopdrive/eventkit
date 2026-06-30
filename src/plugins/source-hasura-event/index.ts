// =============================================================================
// @hopdrive/eventkit — source-hasura-event
// =============================================================================
// The `hasuraEvent` source plugin — Hasura DB event triggers (ADR-023).
// `provides: ['source']`; folder name === plugin `name` (`source-hasura-event`).
// Authoring helpers (ADR-025): `.detector` carries the enriched detector context,
// `.prepare` carries the handler context for a module's once-before-jobs data prep.
// There is no `.handler` — a module declares a static `jobs` array. Shared payload
// parsing / types / context builders live in `../hasura-shared`.
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
import type { HasuraEventPayload, HasuraDetectorContext, HasuraHandlerContext } from '../hasura-shared/types.js';
import { normalizeHasuraEvent, buildHasuraDetectorContext, buildHasuraHandlerContext } from '../hasura-shared/adapter.js';

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

export const hasuraEvent: HasuraEventSource = {
  name: 'source-hasura-event',
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
