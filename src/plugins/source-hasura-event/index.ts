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
  EventModule,
  EventSourceType,
  RequestContext,
  SourceEventModule,
} from '../../core/index.js';
import { defineEvent } from '../../core/index.js';
import type { HasuraEventPayload, HasuraDetectorContext, HasuraHandlerContext } from '../hasura-shared/types.js';
import {
  normalizeHasuraEvent,
  buildHasuraDetectorContext,
  buildHasuraHandlerContext,
  type HasuraEventNormalizeConfig,
} from '../hasura-shared/adapter.js';
import { callableSource, authoringHelper } from '../hasura-shared/callable-source.js';

/**
 * Source config for `hasuraEvent` — the second arg of `createEventKit`. Inbound token
 * discovery (`tokenField`, `tokenSessionVariables`) plus the trace-id policy
 * (`correlationFromTraceId`, default false — see {@link HasuraEventNormalizeConfig}).
 */
export type HasuraEventConfig = HasuraEventNormalizeConfig;

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
  /**
   * Source-scoped module builder: `hasuraEvent.defineEvent<Row>({ ... })`. The row
   * type on THIS call flows into every inline seam — a bare `detector: (ctx) => ...`
   * arrow gets the full Hasura context (`ctx.operation`, `ctx.columnChanged`,
   * `ctx.newRow`) with no per-seam `.detector()` wrapper. Runtime = core
   * `defineEvent` (name branding only). See `SourceEventModule` for the TPrepared
   * caveat when the row type is passed explicitly.
   */
  defineEvent<TNewRow = Record<string, unknown>, TOldRow = TNewRow, TPrepared extends Record<string, unknown> = Record<string, unknown>>(
    module: SourceEventModule<HasuraDetectorContext<TNewRow, TOldRow>, HasuraHandlerContext<TNewRow, TOldRow>, TPrepared>,
  ): EventModule<HasuraEventPayload<TNewRow, TOldRow>, Record<string, unknown>, TPrepared>;
}

// The same core defineEvent function, re-typed so the row type parameter on the
// OUTER call contextually types every inline seam (the runtime shape is identical).
const defineHasuraEvent = defineEvent as unknown as HasuraEventSource['defineEvent'];

/** Build the plugin object; `normalize` closes over the source config (ADR-039.2). */
function build(config: HasuraEventConfig): EventKitPlugin {
  return {
    name: 'source-hasura-event',
    provides: ['source', 'source:hasura'],
    sourceType: 'database',
    detector: authoringHelper,
    prepare: authoringHelper,
    defineEvent: defineHasuraEvent,
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
