// =============================================================================
// @hopdrive/eventkit — source-hasura-cron
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

export const hasuraCron: HasuraCronSource = {
  name: 'source-hasura-cron',
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
