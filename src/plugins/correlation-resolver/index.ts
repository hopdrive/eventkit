// =============================================================================
// @hopdrive/eventkit/plugins/correlation-resolver
// =============================================================================
// Reconnects a chain across an external vendor round-trip (ADR-028, §13). When an
// inbound signal (a vendor webhook) carries only the VENDOR's own id — not our
// correlation id or tracking token — loop-guard's payload extraction can't recover
// the lineage. This plugin closes that gap with an async DB lookup keyed by the
// vendor's id: the origin job persisted `vendorId → trackingToken` at call time, and
// here we read it back and adopt it.
//
// It rides the SAME envelope seam loop-guard uses (`augmentEnvelope`, now awaitable),
// setting the same fields, so everything downstream is identical to a DB→DB chain:
//   • envelope.correlationId         — the recovered chain id (beats the fresh one);
//   • envelope.meta.sourceTrackingToken — the recovered token (if any);
//   • envelope.meta.sourceJobId      — the parent job (given, or parsed from the token).
//
// Generic (ADR-024): it never touches the DB itself. The app injects `extractKey`
// (pull the vendor id out of THIS vendor's body) and `lookup` (the SDK/DB query) —
// exactly like a `sink`/`store`. Registered AFTER loop-guard, it stands down when the
// echo-back path (loop-guard) already recovered the lineage (`skipIfResolved`).
import type { CorrelationId, EventEnvelope, EventKitPlugin } from '../../core/index.js';
import { asCorrelationId } from '../../core/index.js';
import { createTokenCodec, type TokenCodec, type TokenCodecConfig } from '../loop-guard/codec.js';

/** What an injected `lookup` returns: the recovered lineage for a vendor key. */
export interface ResolvedCorrelation {
  /** The origin chain id. Required — without it there's nothing to reconnect. */
  correlationId: string;
  /** The origin job's tracking token (`source|correlationId|jobId`), if stored. */
  trackingToken?: string;
  /** The parent job id. Given directly, or parsed from `trackingToken` via the codec. */
  sourceJobId?: string;
}

export interface CorrelationResolverConfig<K = unknown> {
  /**
   * Pull the vendor's correlating key out of the inbound envelope (e.g. the body's
   * `ride_id`). Return `null`/`undefined` when this signal carries no key — the
   * invocation then stays a fresh chain root.
   */
  extractKey: (envelope: EventEnvelope) => K | null | undefined;
  /**
   * The injected mapping query: `vendorKey → recovered lineage`. May be async (a DB
   * read). Return `null`/`undefined` for a miss. The plugin NEVER reads the DB itself.
   */
  lookup: (key: K) => Promise<ResolvedCorrelation | null | undefined> | ResolvedCorrelation | null | undefined;
  /**
   * Skip the lookup when an upstream plugin (loop-guard's echo-back path) already
   * recovered the lineage — detected via `meta.sourceTrackingToken`. Default true, so
   * the cheap sync path wins and the DB read only happens when it's actually needed.
   */
  skipIfResolved?: boolean;
  /** Codec for parsing a returned `trackingToken` to recover the parent job id. HopDrive pins `{ separator: '|' }`. */
  codec?: TokenCodecConfig;
  /**
   * Called when `extractKey` yields nothing OR `lookup` finds no mapping. Best-effort
   * hook for logging the orphan (the invocation proceeds as a clean new chain root).
   */
  onMiss?: (envelope: EventEnvelope, key: K | null | undefined) => void;
}

export function correlationResolver<K = unknown>(config: CorrelationResolverConfig<K>): EventKitPlugin {
  if (typeof config?.extractKey !== 'function' || typeof config?.lookup !== 'function') {
    throw new Error('correlationResolver() requires `extractKey` and `lookup` functions.');
  }
  const skipIfResolved = config.skipIfResolved !== false;
  const codec: TokenCodec = createTokenCodec(config.codec);

  return {
    name: 'correlation-resolver',

    async augmentEnvelope(envelope) {
      // Echo-back (loop-guard) already reconnected the chain — don't pay for a DB read.
      if (skipIfResolved && envelope.meta?.['sourceTrackingToken']) return undefined;

      const key = config.extractKey(envelope);
      if (key === null || key === undefined) {
        config.onMiss?.(envelope, key);
        return undefined;
      }

      const resolved = await config.lookup(key);
      if (!resolved || !resolved.correlationId) {
        config.onMiss?.(envelope, key);
        return undefined;
      }

      const meta: Record<string, unknown> = { ...envelope.meta };
      let sourceJobId = resolved.sourceJobId;
      if (resolved.trackingToken) {
        meta['sourceTrackingToken'] = resolved.trackingToken;
        if (!sourceJobId) sourceJobId = codec.getJobExecutionId(resolved.trackingToken) ?? undefined;
      }
      if (sourceJobId) meta['sourceJobId'] = sourceJobId;

      // The recovered correlation id beats the source-minted fresh one (chaining, §13).
      return { correlationId: asCorrelationId(resolved.correlationId) as CorrelationId, meta };
    },
  };
}
