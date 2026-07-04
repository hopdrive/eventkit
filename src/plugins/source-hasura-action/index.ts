// =============================================================================
// eventkit — source-hasura-action
// =============================================================================
// The `hasuraAction` request/response source plugin — Hasura Actions (§7.2, ADR-026).
// `provides: ['source']`; folder name === plugin `name` (`source-hasura-action`).
// Adds `.resolve` (computes the action's synchronous response body) alongside
// `.detector`/`.prepare`. Shared parsing / types / context builders live in
// `../hasura-shared`.
import type {
  DetectorContext,
  DetectorFunction,
  HandlerContext,
  PrepareFunction,
  ResolveFunction,
  EventKitPlugin,
  EventEnvelope,
  EventSourceType,
  RequestContext,
} from '../../core/index.js';
import type { HasuraActionPayload, HasuraActionContext, HasuraActionHandlerContext } from '../hasura-shared/types.js';
import { normalizeHasuraAction, buildHasuraActionDetectorContext, buildHasuraActionHandlerContext } from '../hasura-shared/adapter.js';
import type { HasuraTokenDiscoveryConfig } from '../hasura-shared/token-discovery.js';

/** Source config for `hasuraAction` — the second arg of `createEventKit`. */
export type HasuraActionConfig = HasuraTokenDiscoveryConfig;

/**
 * The `hasuraAction` request/response source adapter plus its authoring helpers (§7.2, ADR-026).
 * Also CALLABLE as a factory (ADR-039.2): `createEventKit(hasuraAction, { tokenSessionVariables })`
 * configures inbound token discovery (actions carry tokens on session variables only).
 */
export interface HasuraActionSource extends EventKitPlugin {
  (config?: HasuraActionConfig): EventKitPlugin;
  sourceType: EventSourceType;
  detector<TInput = Record<string, unknown>>(
    fn: (ctx: HasuraActionContext<TInput>) => boolean | Promise<boolean>,
  ): DetectorFunction<HasuraActionPayload<TInput>>;
  prepare<TInput = Record<string, unknown>, TPrepared extends Record<string, unknown> = Record<string, unknown>>(
    fn: (ctx: HasuraActionHandlerContext<TInput>) => TPrepared | Promise<TPrepared>,
  ): PrepareFunction<HasuraActionPayload<TInput>>;
  /** Computes the action's synchronous response body (§7.2). Throw `ActionError`/`ClientError` for a 4xx. */
  resolve<TInput = Record<string, unknown>, TOutput = unknown>(
    fn: (ctx: HasuraActionHandlerContext<TInput> & { prepared: Record<string, unknown> }) => TOutput | Promise<TOutput>,
  ): ResolveFunction<HasuraActionPayload<TInput>>;
}

function detector(fn: unknown): DetectorFunction {
  return fn as unknown as DetectorFunction;
}
function prepare(fn: unknown): PrepareFunction {
  return fn as unknown as PrepareFunction;
}
function resolve(fn: unknown): ResolveFunction {
  return fn as unknown as ResolveFunction;
}

/** Build the plugin object; `normalize` closes over the source config (ADR-039.2). */
function build(config: HasuraActionConfig): EventKitPlugin {
  return {
    name: 'source-hasura-action',
    provides: ['source', 'source:hasura-action'],
    sourceType: 'action',
    detector,
    prepare,
    resolve,
    normalize(raw: unknown, request: RequestContext): EventEnvelope {
      return normalizeHasuraAction(raw, request, config) as EventEnvelope;
    },
    buildDetectorContext(envelope: EventEnvelope, base: DetectorContext): HasuraActionContext {
      return buildHasuraActionDetectorContext(envelope as EventEnvelope<HasuraActionPayload>, base as DetectorContext<HasuraActionPayload>);
    },
    buildHandlerContext(envelope: EventEnvelope, base: HandlerContext) {
      return buildHasuraActionHandlerContext(envelope as EventEnvelope<HasuraActionPayload>, base as HandlerContext<HasuraActionPayload>);
    },
  } as EventKitPlugin;
}

const factory = (config: HasuraActionConfig = {}): EventKitPlugin => build(config);
const defaults = build({});
const { name: pluginName, ...rest } = defaults;
Object.assign(factory, rest, { detector, prepare, resolve });
Object.defineProperty(factory, 'name', { value: pluginName, configurable: true });
export const hasuraAction = factory as HasuraActionSource;
