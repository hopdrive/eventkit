// =============================================================================
// eventkit — source-hasura-event
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
import { callableSource, authoringHelper } from '../hasura-shared/callable-source.js';
import type { HasuraTokenDiscoveryConfig } from '../hasura-shared/token-discovery.js';

/** Source config for `hasuraEvent` — the second arg of `createEventKit`. */
export type HasuraEventConfig = HasuraTokenDiscoveryConfig;

/**
 * The `hasuraEvent` source adapter plus its authoring helpers. Also CALLABLE as a
 * factory (ADR-039.2): `createEventKit(hasuraEvent, { tokenField })` configures
 * inbound token discovery; bare `hasuraEvent` uses defaults. The typed helper
 * signatures below (incl. the D32 `TPrepared` inference on `prepare`) ARE the
 * public authoring contract; at runtime the helpers are identity wrappers.
 */
export interface HasuraEventSource extends EventKitPlugin {
  (config?: HasuraEventConfig): EventKitPlugin;
  sourceType: EventSourceType;
  detector<TNewRow = Record<string, unknown>, TOldRow = TNewRow>(
    fn: (ctx: HasuraDetectorContext<TNewRow, TOldRow>) => boolean | Promise<boolean>,
  ): DetectorFunction<HasuraEventPayload<TNewRow, TOldRow>>;
  prepare<TNewRow = Record<string, unknown>, TOldRow = TNewRow, TPrepared extends Record<string, unknown> = Record<string, unknown>>(
    fn: (ctx: HasuraHandlerContext<TNewRow, TOldRow>) => TPrepared | Promise<TPrepared>,
  ): PrepareFunction<HasuraEventPayload<TNewRow, TOldRow>, Record<string, unknown>, TPrepared>;
}

/** Build the plugin object; `normalize` closes over the source config (ADR-039.2). */
function build(config: HasuraEventConfig): EventKitPlugin {
  return {
    name: 'source-hasura-event',
    provides: ['source', 'source:hasura'],
    sourceType: 'database',
    detector: authoringHelper,
    prepare: authoringHelper,
    // Shape-3 capabilities.
    normalize(raw: unknown, request: RequestContext): EventEnvelope {
      return normalizeHasuraEvent(raw, request, config) as EventEnvelope;
    },
    buildDetectorContext(envelope: EventEnvelope, base: DetectorContext): HasuraDetectorContext {
      return buildHasuraDetectorContext(envelope as EventEnvelope<HasuraEventPayload>, base as DetectorContext<HasuraEventPayload>);
    },
    buildHandlerContext(envelope: EventEnvelope, base: HandlerContext) {
      return buildHasuraHandlerContext(envelope as EventEnvelope<HasuraEventPayload>, base as HandlerContext<HasuraEventPayload>);
    },
  } as EventKitPlugin;
}

export const hasuraEvent = callableSource<HasuraEventConfig, HasuraEventSource>(build);
