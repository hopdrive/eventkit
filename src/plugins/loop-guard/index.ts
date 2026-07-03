// =============================================================================
// @hopdrive/eventkit/plugins/loop-guard
// =============================================================================
// Generic loop guard (tracking token), config-driven (ADR-024). A pure
// `source|correlationId|jobExecutionId` codec plus configurable inbound extraction
// strategies and a service identity — nothing HopDrive-specific.
//
//  - INBOUND  (augmentEnvelope): extract the prior correlation id + token from the
//    inbound payload (updated_by token, a configured pattern, a bare UUID, a
//    metadata key, a session variable, or a custom field — strategies ported from
//    the legacy TrackingTokenExtractionPlugin). Sets:
//      • envelope.correlationId        — so the whole write→event→write chain
//        shares ONE id (chaining beats a fresh source/trace id);
//      • envelope.meta.sourceTrackingToken — the original token (if any);
//      • envelope.meta.sourceJobId      — the prior job's id (observability link).
//  - OUTBOUND (augmentJobContext): set ctx.trackingToken to a token continuing the
//    inbound lineage (same source + correlation, this job's id), else mint from
//    serviceId. Jobs stamp it into the write field so the next invocation
//    recognizes the write as system-originated.
import type { CorrelationId, EventEnvelope, EventKitPlugin, HandlerLogger, JobContext, KitContext } from '../../core/index.js';
import { asCorrelationId } from '../../core/index.js';
import { createTokenCodec, type TokenCodec, type TokenCodecConfig } from './codec.js';

export type { TokenCodec, TokenCodecConfig, TokenComponents } from './codec.js';
export { createTokenCodec } from './codec.js';

type Row = Record<string, unknown>;

export interface LoopGuardConfig {
  /** Primary write field. Default `'updated_by'` (`'updatedby'` is also checked). */
  field?: string;
  /** This service's identity, used as the token `source` when minting. Default `'eventkit'`. */
  serviceId?: string;
  /** Codec config (separator + correlation-id validation). HopDrive pins `{ separator: '|', validateCorrelationId: true }`. */
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

  // ── Extraction strategies (defaults match the legacy plugin — all on) ──────
  extractFromUpdatedBy?: boolean;
  extractFromMetadata?: boolean;
  extractFromSession?: boolean;
  extractFromCustomField?: string;
  /** Regex fallback for the write field; capture group 1 is the correlation id. */
  updatedByPattern?: RegExp;
  /** Session-variable names to check, in order. */
  sessionVariables?: string[];
  /** Metadata keys to check (on the row, and nested in metadata/data/properties/attributes). */
  metadataKeys?: string[];

  // ── Source-shape accessors (override for non-Hasura sources) ───────────────
  /** Override the full inbound-token reader. */
  read?: (envelope: EventEnvelope) => string | null | undefined;
  /** Override how the changed row is found. Default: Hasura `event.data.new`/`old`, else the flat payload. */
  getRow?: (envelope: EventEnvelope) => Row | null;
  /** Override how session variables are found. Default: Hasura `event.session_variables`. */
  getSession?: (envelope: EventEnvelope) => Row | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_UPDATED_BY_PATTERN = /^[^|]+\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\|[^|]+)?$/i;

const defaultGetRow = (envelope: EventEnvelope): Row | null => {
  const p = envelope.payload as { event?: { data?: { new?: Row | null; old?: Row | null } } } | Row | null | undefined;
  const data = (p as { event?: { data?: { new?: Row | null; old?: Row | null } } })?.event?.data;
  if (data) return data.new ?? data.old ?? null;
  return p && typeof p === 'object' ? (p as Row) : null;
};

const defaultGetSession = (envelope: EventEnvelope): Row | null => {
  const p = envelope.payload as { event?: { session_variables?: Row | null } } | null | undefined;
  return p?.event?.session_variables ?? null;
};

const asString = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

interface Extracted {
  correlationId?: string;
  sourceJobId?: string;
  sourceTrackingToken?: string;
  /** The inbound token's hop counter (ADR-034), if it carried one. */
  hopDepth?: number;
}

export function loopGuard(config: LoopGuardConfig = {}): EventKitPlugin {
  const field = config.field ?? 'updated_by';
  const serviceId = config.serviceId ?? 'eventkit';
  const codec: TokenCodec = createTokenCodec(config.codec);
  const { warnAtDepth, haltAtDepth } = config;
  const trackDepth = warnAtDepth !== undefined || haltAtDepth !== undefined;
  let kitLog: HandlerLogger | undefined;
  const extractFromUpdatedBy = config.extractFromUpdatedBy !== false;
  const extractFromMetadata = config.extractFromMetadata !== false;
  const extractFromSession = config.extractFromSession !== false;
  const customField = config.extractFromCustomField;
  const updatedByPattern = config.updatedByPattern ?? DEFAULT_UPDATED_BY_PATTERN;
  const sessionVariables = config.sessionVariables ?? ['x-correlation-id', 'x-request-id', 'x-trace-id'];
  const metadataKeys = config.metadataKeys ?? ['correlation_id', 'trace_id', 'request_id', 'workflow_id'];
  const getRow = config.getRow ?? defaultGetRow;
  const getSession = config.getSession ?? defaultGetSession;

  const readUpdatedBy = (envelope: EventEnvelope, row: Row | null): string | undefined => {
    if (config.read) return asString(config.read(envelope));
    return asString(row?.[field]) ?? asString(row?.['updatedby']) ?? asString(row?.['updated_by']);
  };

  const fromMetadata = (row: Row | null): string | undefined => {
    if (!row) return undefined;
    for (const key of metadataKeys) {
      const direct = asString(row[key]);
      if (direct) return direct;
      for (const container of ['metadata', 'data', 'properties', 'attributes']) {
        const obj = row[container];
        if (obj && typeof obj === 'object') {
          const nested = asString((obj as Row)[key]);
          if (nested) return nested;
        }
      }
    }
    return undefined;
  };

  const fromSession = (session: Row | null): string | undefined => {
    if (!session) return undefined;
    for (const name of sessionVariables) {
      const v = asString(session[name]);
      if (v) return v;
    }
    return undefined;
  };

  const extract = (envelope: EventEnvelope): Extracted => {
    const row = getRow(envelope);
    const out: Extracted = {};

    // Strategy 1: the write field (full token → pattern → bare UUID).
    if (extractFromUpdatedBy) {
      const updatedBy = readUpdatedBy(envelope, row);
      if (updatedBy) {
        const parsed = codec.parse(updatedBy);
        if (parsed) {
          out.correlationId = parsed.correlationId;
          if (parsed.jobExecutionId) out.sourceJobId = parsed.jobExecutionId;
          if (parsed.hopDepth !== undefined) out.hopDepth = parsed.hopDepth;
          out.sourceTrackingToken = updatedBy;
        } else {
          const m = updatedBy.match(updatedByPattern);
          if (m?.[1]) {
            out.correlationId = m[1];
            out.sourceTrackingToken = updatedBy;
          } else if (UUID_RE.test(updatedBy)) {
            out.correlationId = updatedBy;
            out.sourceTrackingToken = updatedBy;
          }
        }
      }
    }
    // Strategy 2: custom field.
    if (!out.correlationId && customField) {
      const v = asString(row?.[customField]);
      if (v) out.correlationId = v;
    }
    // Strategy 3: metadata keys (row + nested containers).
    if (!out.correlationId && extractFromMetadata) {
      const v = fromMetadata(row);
      if (v) out.correlationId = v;
    }
    // Strategy 4: session variables. A session variable can carry a FULL token (the
    // transient header channel: `x-hasura-*` headers on the originating mutation land
    // in the event's session_variables without persisting to the row) — parse it like
    // the write field so sourceJobId/hopDepth survive the hop. A bare id still chains.
    if (!out.correlationId && extractFromSession) {
      const v = fromSession(getSession(envelope));
      if (v) {
        const parsed = codec.parse(v);
        if (parsed) {
          out.correlationId = parsed.correlationId;
          if (parsed.jobExecutionId) out.sourceJobId = parsed.jobExecutionId;
          if (parsed.hopDepth !== undefined) out.hopDepth = parsed.hopDepth;
          out.sourceTrackingToken = v;
        } else {
          out.correlationId = v;
        }
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
      const { correlationId, sourceJobId, sourceTrackingToken, hopDepth } = extract(envelope);
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
        if (haltAtDepth !== undefined && depth >= haltAtDepth) {
          // The generic runtime seam (ADR-034): a reason string here hard-stops dispatch.
          meta['suppressDispatch'] = `loop-guard: hop depth ${depth} reached haltAtDepth ${haltAtDepth} — dispatch suppressed`;
          kitLog?.warn('loop-guard halted a chain at its hop-depth ceiling', { depth, haltAtDepth, correlationId });
        } else if (warnAtDepth !== undefined && depth >= warnAtDepth) {
          kitLog?.warn('loop-guard hop-depth warning', { depth, warnAtDepth, correlationId });
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
