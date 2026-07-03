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
import { asCorrelationId, ClientError } from '../../core/index.js';
import { createTokenCodec, type TokenCodec, type TokenCodecConfig } from '../../core/tracking-token.js';

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
  /**
   * What to do when `lookup` THROWS (a DB blip, not a miss). Default `'ignore'`:
   * best-effort — the throw propagates and the pre-dispatch pipeline isolates it
   * (ADR-033), so the event proceeds as an un-correlated new chain root and the error
   * is logged via `onError`. Set `'reject'` when the correlation is load-bearing and a
   * transient failure must NOT silently drop the chain: the lookup throw is rethrown as
   * a branded `ClientError(503)`, which surfaces as a 5xx so the vendor retries.
   */
  onLookupError?: 'ignore' | 'reject';
}

export function correlationResolver<K = unknown>(config: CorrelationResolverConfig<K>): EventKitPlugin {
  if (typeof config?.extractKey !== 'function' || typeof config?.lookup !== 'function') {
    throw new Error('correlationResolver() requires `extractKey` and `lookup` functions.');
  }
  const skipIfResolved = config.skipIfResolved !== false;
  const onLookupError = config.onLookupError ?? 'ignore';
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

      let resolved: ResolvedCorrelation | null | undefined;
      if (onLookupError === 'reject') {
        // Load-bearing: a lookup failure must fail the request loudly so the vendor
        // retries, not degrade to an un-correlated root. Rethrow as a branded ClientError
        // (5xx) — the pipeline re-throws branded ClientErrors instead of isolating them.
        try {
          resolved = await config.lookup(key);
        } catch (err) {
          throw new ClientError(503, `correlation-resolver lookup failed; rejecting so the source retries (${String((err as { message?: unknown })?.message ?? err)})`);
        }
      } else {
        // Best-effort (default): let a throw propagate — the pre-dispatch pipeline
        // isolates it (ADR-033) and the event proceeds as a fresh chain root.
        resolved = await config.lookup(key);
      }
      if (!resolved || !resolved.correlationId) {
        config.onMiss?.(envelope, key);
        return undefined;
      }

      const meta: Record<string, unknown> = { ...envelope.meta };
      let sourceJobId = resolved.sourceJobId;
      if (resolved.trackingToken) {
        meta['sourceTrackingToken'] = resolved.trackingToken;
        const parsed = codec.parse(resolved.trackingToken);
        if (!sourceJobId) sourceJobId = parsed?.jobExecutionId;
        // Continue the token's hop counter (ADR-034) across the vendor round trip.
        // loop-guard ran BEFORE this plugin, saw no inbound token, and set the depth as
        // if this were a fresh root — overwrite it so a resolver-recovered hop counts
        // and `haltAtDepth` can't be evaded by bouncing a chain off a vendor. Harmless
        // when depth tracking is off (loop-guard then never reads `hopDepth`).
        if (parsed?.hopDepth !== undefined) meta['hopDepth'] = parsed.hopDepth + 1;
      }
      if (sourceJobId) meta['sourceJobId'] = sourceJobId;

      // The recovered correlation id beats the source-minted fresh one (chaining, §13).
      return { correlationId: asCorrelationId(resolved.correlationId) as CorrelationId, meta };
    },
  };
}
