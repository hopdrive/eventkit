// =============================================================================
// eventkit — source-hasura-cron
// =============================================================================
// The `hasuraCron` source plugin — Hasura scheduled (cron) triggers (ADR-023).
// `provides: ['source']`; folder name === plugin `name` (`source-hasura-cron`).
// Detector context: `scheduleName`/`scheduledAt`/`payload` (no rows/operation).
// Shared payload parsing / types / context builders live in `../hasura-shared`.
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
import type { HasuraCronPayload, HasuraCronContext, HasuraCronHandlerContext } from '../hasura-shared/types.js';
import { normalizeHasuraCron, buildHasuraCronDetectorContext, buildHasuraCronHandlerContext } from '../hasura-shared/adapter.js';
import { callableSource, authoringHelper } from '../hasura-shared/callable-source.js';
import type { HasuraTokenDiscoveryConfig } from '../hasura-shared/token-discovery.js';

/** Source config for `hasuraCron` — the second arg of `createEventKit`. */
export type HasuraCronConfig = HasuraTokenDiscoveryConfig;

/**
 * The `hasuraCron` source adapter plus its authoring helpers. Also CALLABLE as a
 * factory (ADR-039.2) for a uniform config surface, though a cron payload carries
 * no inbound token channel (the config is a no-op here).
 */
export interface HasuraCronSource extends EventKitPlugin {
  (config?: HasuraCronConfig): EventKitPlugin;
  sourceType: EventSourceType;
  detector<TPayload = Record<string, unknown>>(
    fn: (ctx: HasuraCronContext<TPayload>) => boolean | Promise<boolean>,
  ): DetectorFunction<HasuraCronPayload<TPayload>>;
  prepare<TPayload = Record<string, unknown>, TPrepared extends Record<string, unknown> = Record<string, unknown>>(
    fn: (ctx: HasuraCronHandlerContext<TPayload>) => TPrepared | Promise<TPrepared>,
  ): PrepareFunction<HasuraCronPayload<TPayload>>;
}

/** Build the plugin object; `normalize` closes over the source config (ADR-039.2). */
function build(config: HasuraCronConfig): EventKitPlugin {
  return {
    name: 'source-hasura-cron',
    provides: ['source', 'source:hasura-cron'],
    sourceType: 'cron',
    detector: authoringHelper,
    prepare: authoringHelper,
    normalize(raw: unknown, request: RequestContext): EventEnvelope {
      return normalizeHasuraCron(raw, request, config) as EventEnvelope;
    },
    buildDetectorContext(envelope: EventEnvelope, base: DetectorContext): HasuraCronContext {
      return buildHasuraCronDetectorContext(envelope as EventEnvelope<HasuraCronPayload>, base as DetectorContext<HasuraCronPayload>);
    },
    buildHandlerContext(envelope: EventEnvelope, base: HandlerContext) {
      return buildHasuraCronHandlerContext(envelope as EventEnvelope<HasuraCronPayload>, base as HandlerContext<HasuraCronPayload>);
    },
  } as EventKitPlugin;
}

export const hasuraCron = callableSource<HasuraCronConfig, HasuraCronSource>(build);
