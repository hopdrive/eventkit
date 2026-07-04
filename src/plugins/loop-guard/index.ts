// =============================================================================
// eventkit/plugins/loop-guard
// =============================================================================
// Truly generic loop guard (ADR-039.3). It owns POLICY, not payload anatomy:
// SOURCES surface ordered inbound tracking-token candidates on
// `envelope.meta.tokenCandidates` during normalize (the source knows which fields
// and session variables carry a token — ADR-039.2); loopGuard consumes them and:
//   • CHAINS the correlation id (the whole write→event→write chain shares ONE id);
//   • LIFTS the inbound token, prior job id, and hop depth from the first candidate
//     that parses as a full token;
//   • owns the HOP-DEPTH CEILING (warn/halt, ADR-034) and elevates a halted or
//     nearing-halt chain as a branded `LoopDetectedError` through the chain-guard
//     seam (ADR-041) so any alerting backend routes on it;
//   • sets the AMBIENT OUTBOUND token (`ctx.trackingToken`) continuing the inbound
//     lineage, else minting from `serviceId`.
//
// Extraction (augmentEnvelope):
//   1. Gather candidates: `envelope.meta.tokenCandidates`, then any returned by the
//      generic `candidates` escape hatch (for exotic sources that surface none).
//   2. The FIRST candidate that `codec.parse()`s as a full token WINS: its
//      correlation id, sourceJobId, and hop depth are lifted and it becomes
//      `meta.sourceTrackingToken`.
//   3. If NO candidate parses as a token, the FIRST candidate shaped like a bare
//      correlation id CHAINS as a correlation id only — no sourceTrackingToken, no
//      sourceJobId. A bare id is not a token: correlationResolver's `skipIfResolved`
//      must still see "unresolved" (no sourceTrackingToken) and recover full lineage.
//      (Deliberate change from the old write-field behavior, which set
//      sourceTrackingToken for a bare UUID.)
//
// loopGuard contains ZERO payload anatomy — no getRow/getSession/updated_by/session
// variables. HopDrive consumers use the `hopdriveLoopGuard` preset (ADR-039.6),
// which pins the codec and pairs with the Hasura source defaults.
import type { CorrelationId, EventEnvelope, EventKitPlugin, HandlerLogger, JobContext, KitContext } from '../../core/index.js';
import { asCorrelationId, LoopDetectedError, SUPPRESS_DISPATCH_KEY, CHAIN_GUARD_WARNING_KEY } from '../../core/index.js';
import type { SuppressDispatch, ChainGuardWarning } from '../../core/index.js';
import { createTokenCodec, isCorrelationIdShape, type TokenCodec, type TokenCodecConfig } from '../../core/tracking-token.js';

export type { TokenCodec, TokenCodecConfig, TokenComponents } from '../../core/tracking-token.js';
export { createTokenCodec } from '../../core/tracking-token.js';
export { hopdriveLoopGuard, type HopdriveLoopGuardConfig } from './hopdrive.js';

export interface LoopGuardConfig {
  /** This service's identity, the token `source` when minting. Default `'eventkit'`. */
  serviceId?: string;
  /** Codec config (separator + correlation-id validation). HopDrive pins `{ separator: '|', validateCorrelationId: true }` via `hopdriveLoopGuard`. */
  codec?: TokenCodecConfig;

  // ── Hop-depth ceiling (ADR-034) — off by default (depth unbounded = today's behavior) ──
  /**
   * Log a warning (a breadcrumb via the kit logger) once this invocation's hop depth
   * reaches this value, WITHOUT stopping it. A bounded early signal that a chain is
   * running deep. Setting either `warnAtDepth` or `haltAtDepth` turns on the hop counter,
   * which then rides the tracking token as an optional 4th segment.
   */
  warnAtDepth?: number;
  /**
   * Hard-stop: once this invocation's hop depth reaches this value, suppress dispatch
   * (no detector runs) and log. Converts an unbounded A→B→A cycle into a bounded blast
   * radius (ADR-016). The ceiling is a per-repo decision; unset means unbounded.
   */
  haltAtDepth?: number;

  /**
   * Generic escape hatch for exotic sources that don't surface `meta.tokenCandidates`:
   * return extra ordered candidates for this envelope (appended after the source's).
   */
  candidates?: (envelope: EventEnvelope) => string[] | null | undefined;
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

interface Lifted {
  correlationId?: string;
  sourceJobId?: string;
  sourceTrackingToken?: string;
  /** The inbound token's hop counter (ADR-034), if it carried one. */
  hopDepth?: number;
}

export function loopGuard(config: LoopGuardConfig = {}): EventKitPlugin {
  const serviceId = config.serviceId ?? 'eventkit';
  const codec: TokenCodec = createTokenCodec(config.codec);
  const { warnAtDepth, haltAtDepth } = config;
  const trackDepth = warnAtDepth !== undefined || haltAtDepth !== undefined;
  let kitLog: HandlerLogger | undefined;

  const gatherCandidates = (envelope: EventEnvelope): string[] => {
    const out: string[] = [];
    const surfaced = (envelope.meta as { tokenCandidates?: unknown })?.tokenCandidates;
    if (Array.isArray(surfaced)) {
      for (const c of surfaced) {
        const s = asString(c);
        if (s) out.push(s);
      }
    }
    const extra = config.candidates?.(envelope);
    if (Array.isArray(extra)) {
      for (const c of extra) {
        const s = asString(c);
        if (s) out.push(s);
      }
    }
    return out;
  };

  const lift = (envelope: EventEnvelope): Lifted => {
    const candidates = gatherCandidates(envelope);
    const out: Lifted = {};

    // The first candidate that parses as a FULL token wins — lineage lifted.
    for (const candidate of candidates) {
      const parsed = codec.parse(candidate);
      if (parsed) {
        out.correlationId = parsed.correlationId;
        if (parsed.jobExecutionId) out.sourceJobId = parsed.jobExecutionId;
        if (parsed.hopDepth !== undefined) out.hopDepth = parsed.hopDepth;
        out.sourceTrackingToken = candidate;
        return out;
      }
    }
    // No full token: the first bare-correlation-id-shaped candidate chains as a
    // correlation id ONLY (no sourceTrackingToken — a bare id is not a token).
    for (const candidate of candidates) {
      if (isCorrelationIdShape(candidate)) {
        out.correlationId = candidate;
        return out;
      }
    }
    return out;
  };

  return {
    name: 'loop-guard',

    onInit(ctx: KitContext) {
      kitLog = ctx.log;
    },

    augmentEnvelope(envelope) {
      const { correlationId, sourceJobId, sourceTrackingToken, hopDepth } = lift(envelope);
      // With the hop counter on, this invocation is always one hop deeper than the token
      // that triggered it (a fresh root is depth 1). Off → nothing here changes.
      if (!correlationId && !sourceTrackingToken && !trackDepth) return undefined;

      const meta: Record<string, unknown> = { ...envelope.meta };
      const partial: Partial<EventEnvelope> = {};
      // Chaining: the inbound correlation id overrides the source-derived/generated one.
      if (correlationId) partial.correlationId = asCorrelationId(correlationId) as CorrelationId;
      if (sourceTrackingToken) meta['sourceTrackingToken'] = sourceTrackingToken;
      if (sourceJobId) meta['sourceJobId'] = sourceJobId;

      if (trackDepth) {
        const depth = (hopDepth ?? 0) + 1;
        meta['hopDepth'] = depth;
        // The correlation id this invocation resolved to (lifted, else the envelope's).
        const resolvedCorrelation = correlationId ?? String(envelope.correlationId ?? '');
        const sourceFunction = asString((envelope.meta as { sourceFunction?: unknown })?.sourceFunction);
        if (haltAtDepth !== undefined && depth >= haltAtDepth) {
          const reason = `loop-guard: hop depth ${depth} reached haltAtDepth ${haltAtDepth} — dispatch suppressed`;
          const detail = { correlationId: resolvedCorrelation, depth, ceiling: haltAtDepth, serviceId };
          const error = new LoopDetectedError(reason, sourceFunction !== undefined ? { ...detail, sourceFunction } : detail);
          meta[SUPPRESS_DISPATCH_KEY] = { reason, error } satisfies SuppressDispatch;
          kitLog?.warn('loop-guard halted a chain at its hop-depth ceiling', { depth, haltAtDepth, correlationId: resolvedCorrelation });
        } else if (warnAtDepth !== undefined && depth >= warnAtDepth) {
          const message = `loop-guard: hop depth ${depth} reached warnAtDepth ${warnAtDepth} — chain running deep`;
          const detail = { correlationId: resolvedCorrelation, depth, ceiling: warnAtDepth, serviceId };
          const error = new LoopDetectedError(message, sourceFunction !== undefined ? { ...detail, sourceFunction } : detail);
          meta[CHAIN_GUARD_WARNING_KEY] = { error } satisfies ChainGuardWarning;
          kitLog?.warn('loop-guard hop-depth warning', { depth, warnAtDepth, correlationId: resolvedCorrelation });
        }
      }

      partial.meta = meta;
      return partial;
    },

    augmentJobContext(ctx: JobContext) {
      const inbound = ctx.envelope.meta?.['sourceTrackingToken'];
      const md = ctx.envelope.meta as { hopDepth?: unknown } | undefined;
      // Continue the depth this invocation resolved to (set in augmentEnvelope). Off → undefined,
      // so the outbound token keeps its plain 3-part shape.
      const depth = trackDepth && typeof md?.hopDepth === 'number' ? md.hopDepth : undefined;
      const token =
        typeof inbound === 'string' && codec.isValid(inbound)
          ? codec.withJobExecutionId(inbound, ctx.job.id, depth)
          : codec.create(serviceId, ctx.correlationId, ctx.job.id, depth);
      return { ambient: { trackingToken: token } };
    },
  };
}
