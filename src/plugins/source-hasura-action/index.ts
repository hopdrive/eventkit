// =============================================================================
// eventkit — source-hasura-action
// =============================================================================
// The `hasuraAction` request/response source plugin — Hasura Actions (§7.2, ADR-026).
// `provides: ['source']`; folder name === plugin `name` (`source-hasura-action`).
// The action's work runs as JOBS; the reply is declared at the invocation layer —
// `kit.handler({ after: { fromResults } })`, throwing `ActionError`/`ClientError` for
// a 4xx. Shared parsing / types / context builders live in `../hasura-shared`.
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
import type { HasuraActionPayload, HasuraActionContext, HasuraActionHandlerContext } from '../hasura-shared/types.js';
import { normalizeHasuraAction, buildHasuraActionDetectorContext, buildHasuraActionHandlerContext } from '../hasura-shared/adapter.js';
import { callableSource, authoringHelper } from '../hasura-shared/callable-source.js';
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
  /**
   * Source-scoped module builder: `hasuraAction.defineEvent<Input>({ ... })`. The
   * action-input type on THIS call types every inline seam (`ctx.actionName` /
   * `ctx.input` / `ctx.sessionVariables`), no per-seam wrapper. Runtime = core `defineEvent`.
   */
  defineEvent<TInput = Record<string, unknown>, TPrepared extends Record<string, unknown> = Record<string, unknown>>(
    module: SourceEventModule<HasuraActionContext<TInput>, HasuraActionHandlerContext<TInput>, TPrepared>,
  ): EventModule<HasuraActionPayload<TInput>, Record<string, unknown>, TPrepared>;
}

// Core defineEvent, re-typed so the input type on the OUTER call types every inline seam.
const defineActionEvent = defineEvent as unknown as HasuraActionSource['defineEvent'];

/** Build the plugin object; `normalize` closes over the source config (ADR-039.2). */
function build(config: HasuraActionConfig): EventKitPlugin {
  return {
    name: 'source-hasura-action',
    provides: ['source', 'source:hasura-action'],
    sourceType: 'action',
    detector: authoringHelper,
    prepare: authoringHelper,
    defineEvent: defineActionEvent,
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

export const hasuraAction = callableSource<HasuraActionConfig, HasuraActionSource>(build);
