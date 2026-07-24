// =============================================================================
// eventkit/plugins/origin-decoder
// =============================================================================
// Decodes the invocation's final correlation id and, when it is a structured origin
// id (see src/core/origin-id.ts), drops the decoded fields into request meta so
// observability persists them and the console can show which surface and env started
// the chain.
//
// Where the fields land, and why this hook:
//   observability writes `context_data` from `ctx.request.meta` (see
//   src/plugins/observability/index.ts, the `context_data` assignment). The only plugin
//   hook that contributes to `request.meta` is `configureInvocation`, which returns a
//   `Partial<RequestContext>`. So this plugin uses `configureInvocation`, not
//   `augmentEnvelope`. `augmentEnvelope` writes `envelope.meta`, which feeds source
//   attributes (table/operation/user) but NOT `context_data`.
//
// Ordering — this is the important part:
//   loopGuard and correlationResolver recover the chain's correlation id during
//   `augmentEnvelope` (they chain the inbound id, or look one up after a vendor round
//   trip). In the kit pipeline `augmentEnvelope` runs during intake, and
//   `configureInvocation` runs AFTER it. So by the time this plugin runs, the envelope's
//   correlationId is already the chain's final id, no matter where this plugin sits in
//   the registration list. Registering it after loopGuard and correlationResolver is the
//   clean convention, but the phase order (configureInvocation after augmentEnvelope) is
//   what actually guarantees it decodes the final id.
//
//   On a chained hop the recovered correlation id is the CHAIN ROOT's id, so every
//   invocation in a chain decodes to the same origin. That is intended: the origin is a
//   property of the chain, not of the individual hop.
//
// Behavior:
//   - Decodable id  -> inject a single `origin` object into `request.meta`.
//   - Not decodable -> no-op, zero change to behavior (null from the decoder).
//
// The plugin is inert until a consumer registers it. It never reads the DB, never reads
// process.env, and the decode is display-only (origin ids are spoofable — see the codec
// header and docs/origin-id.md).
import type { EventEnvelope, EventKitPlugin, RequestContext } from '../../core/index.js';
import { decodeOriginId, type DecodedOriginId } from '../../core/index.js';

/** The shape this plugin drops into `request.meta.origin` for a decodable correlation id. */
export interface OriginMeta {
  /** The origin-id spec version that decoded (1 today). */
  idVersion: number;
  /** The opaque minting-surface number, 0-255. */
  originId: number;
  /** Display name for the surface, present only when `options.originNames` maps `originId`. */
  originName?: string;
  /** The env number carried in the id, 0-7. */
  env: number;
  /** Display name for the env ('prod' / 'test' / 'preview' / 'local' / 'unknown'). */
  envName: string;
}

/** A decoder function with the same return contract as {@link decodeOriginId}. */
export type OriginDecoder = (id: string) => DecodedOriginId | null;

export interface OriginDecoderConfig {
  /**
   * Custom decoder. Same return contract as the built-in `decodeOriginId` (return null
   * for an id this decoder doesn't understand). Defaults to the built-in codec's decode.
   * Useful when a consumer mints ids with a different scheme but wants the same meta shape.
   */
  decode?: OriginDecoder;
  /**
   * Optional map from `originId` number to a display name. When it has an entry for the
   * decoded `originId`, the resolved name is added to the injected meta as `originName`.
   * The codec deliberately knows numbers, not names, so this mapping is consumer config.
   */
  originNames?: Record<number, string>;
}

/**
 * Plugin that decodes the invocation's final correlation id and, when it is a structured
 * origin id, injects an `origin` object into `request.meta` so observability persists it
 * (as `context_data.origin`) and the console can read it. No-op on any id it can't decode.
 * Register it alongside loopGuard / correlationResolver (see the module header for the
 * ordering guarantee). Inert until registered.
 */
export function originDecoder(config: OriginDecoderConfig = {}): EventKitPlugin {
  const decode: OriginDecoder = config.decode ?? decodeOriginId;
  const originNames = config.originNames;

  return {
    name: 'origin-decoder',

    configureInvocation(request: RequestContext, envelope: EventEnvelope): Partial<RequestContext> | void {
      // The final correlation id, as recovered by loopGuard / correlationResolver during
      // augmentEnvelope (which already ran). Undefined here just decodes to null -> no-op.
      const id = envelope.correlationId ? String(envelope.correlationId) : '';
      const decoded = decode(id);
      if (!decoded) return undefined;

      const origin: OriginMeta = {
        idVersion: decoded.version,
        originId: decoded.originId,
        env: decoded.env,
        envName: decoded.envName ?? 'unknown',
      };
      const name = originNames?.[decoded.originId];
      if (name !== undefined) origin.originName = name;

      // configureInvocation merges shallowly ({ ...request, ...partial }), so spread the
      // existing request.meta to refine it instead of replacing a sibling's contribution.
      return { meta: { ...request.meta, origin } };
    },
  };
}
