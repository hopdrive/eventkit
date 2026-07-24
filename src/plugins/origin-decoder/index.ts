// =============================================================================
// eventkit/plugins/origin-decoder
// =============================================================================
// Decodes the raw inbound trace id a client sent (`meta.sourceTraceId`) into an
// arbitrary "origin" object and drops it into request meta, so observability persists
// it and the console can show where a chain came from.
//
// The model, in one paragraph:
//   A frontend sends a registered action id as the `x-b3-traceid` header on a Hasura
//   mutation. With Hasura's OpenTelemetry config on, that id lands in the event payload
//   as `event.trace_context.trace_id`, and the Hasura source surfaces it verbatim on
//   `envelope.meta.sourceTraceId`. The trace id is a CONVEYANCE channel only: it is NOT
//   the chain's correlation id (the source mints a fresh correlation id at the root),
//   so a client can neither dictate chain identity nor merge unrelated chains by sending
//   a static id. This plugin reads that conveyed id and, using a decoder the CONSUMER
//   supplies, turns it into display info.
//
// eventkit ships only the mechanism, not a codec. The `decode` function is REQUIRED and
// lives in the consumer's codebase: it maps a trace id to whatever the consumer wants to
// show (typically a lookup in an append-only registry of action ids). It returns a
// JSON-serializable object, or null for a trace id it doesn't recognize (a no-op). The
// plugin does not constrain the object's shape: the console renders whatever is there.
//
// Where the object lands, and why this hook:
//   observability writes `context_data` from `ctx.request.meta` (see
//   src/plugins/observability/index.ts, the `context_data` assignment). The only plugin
//   hook that contributes to `request.meta` is `configureInvocation`, so this plugin uses
//   it. `configureInvocation` also runs after `augmentEnvelope`, where the source set
//   `meta.sourceTraceId`, so the trace id is already on the envelope when this runs.
//
// Only root invocations decode to anything: a downstream hop carries a Hasura-minted
// trace id (a real span id), not the client's action id, so `decode` returns null and
// the plugin is a no-op on every hop. That is intended: origin is a property of the
// chain root.
//
// The plugin is inert until a consumer registers it. It never reads the DB or
// process.env, and a decoded origin is display-only (a client controls the trace id, so
// it is spoofable): never use it as an authz input.
import type { EventEnvelope, EventKitPlugin, RequestContext } from '../../core/index.js';

/**
 * A consumer-supplied decoder: maps a raw inbound trace id to a JSON-serializable origin
 * object, or null for a trace id it doesn't recognize (the plugin then does nothing).
 */
export type OriginDecoder = (traceId: string) => Record<string, unknown> | null;

export interface OriginDecoderConfig {
  /**
   * REQUIRED. Maps `meta.sourceTraceId` to the origin object to show, or null for a
   * trace id it doesn't recognize. This is consumer policy (typically a registry
   * lookup); eventkit ships no built-in codec. Throws at registration if absent.
   */
  decode: OriginDecoder;
}

/**
 * Plugin that decodes the inbound trace id (`meta.sourceTraceId`) with a consumer-supplied
 * `decode` function and injects the result verbatim into `request.meta.origin`, so
 * observability persists it (as `context_data.origin`) and the console can read it. No-op
 * when there is no trace id or `decode` returns null. `decode` is required. Inert until
 * registered.
 */
export function originDecoder(config: OriginDecoderConfig): EventKitPlugin {
  if (typeof config?.decode !== 'function') {
    throw new Error(
      'originDecoder() requires a `decode` function: (traceId) => object | null. eventkit ships no built-in codec; supply your own (e.g. an action-id registry lookup).',
    );
  }
  const decode = config.decode;

  return {
    name: 'origin-decoder',

    configureInvocation(request: RequestContext, envelope: EventEnvelope): Partial<RequestContext> | void {
      // The raw inbound trace id the source conveyed (root invocations only; a hop's
      // Hasura-minted id won't decode). Missing or non-string just no-ops.
      const traceId = (envelope.meta as { sourceTraceId?: unknown } | undefined)?.sourceTraceId;
      if (typeof traceId !== 'string' || traceId.length === 0) return undefined;

      const origin = decode(traceId);
      if (!origin) return undefined;

      // configureInvocation merges shallowly ({ ...request, ...partial }), so spread the
      // existing request.meta to refine it instead of replacing a sibling's contribution.
      return { meta: { ...request.meta, origin } };
    },
  };
}
