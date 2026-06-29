// =============================================================================
// @hopdrive/eventkit/plugins/loop-prevention
// =============================================================================
// Generic loop-prevention (tracking token), config-driven (ADR-024). A pure
// `source|correlationId|jobExecutionId` codec plus a configurable inbound read
// field and a service identity — nothing HopDrive-specific.
//
//  - INBOUND  (augmentEnvelope): read the configured field from the inbound
//    payload into `envelope.meta.sourceTrackingToken`. Detectors/handlers read it
//    to suppress self-triggered work.
//  - OUTBOUND (augmentJobContext): set `ctx.trackingToken` to a token that
//    continues the inbound lineage (same source + correlation, this job's id) when
//    one exists, else mints a fresh one from `serviceId`. Jobs stamp it into the
//    write field so the next invocation recognizes the write as system-originated.
import type { EventEnvelope, EventKitPlugin, JobContext } from '../../core/index.js';
import { createTokenCodec, type TokenCodec, type TokenCodecConfig } from './codec.js';

export type { TokenCodec, TokenCodecConfig, TokenComponents } from './codec.js';
export { createTokenCodec } from './codec.js';

export interface LoopPreventionConfig {
  /** Key read from the inbound row to recover the prior tracking token. Default `'updated_by'`. */
  field?: string;
  /**
   * Override how the inbound token is read from an envelope. Defaults to a
   * source-agnostic reader: a Hasura-style `payload.event.data.new`/`old` row if
   * present, else the payload itself, indexed by `field`.
   */
  read?: (envelope: EventEnvelope) => string | null | undefined;
  /** This service's identity, used as the token `source` when minting a fresh token. Default `'eventkit'`. */
  serviceId?: string;
  /** Codec config (separator + correlation-id validation). HopDrive pins `{ separator: '|', validateCorrelationId: true }`. */
  codec?: TokenCodecConfig;
}

const defaultRead =
  (field: string) =>
  (envelope: EventEnvelope): string | null | undefined => {
    const payload = envelope.payload as
      | { event?: { data?: { new?: Record<string, unknown> | null; old?: Record<string, unknown> | null } } }
      | Record<string, unknown>
      | null
      | undefined;
    const row =
      (payload as { event?: { data?: { new?: Record<string, unknown> | null; old?: Record<string, unknown> | null } } })
        ?.event?.data?.new ??
      (payload as { event?: { data?: { old?: Record<string, unknown> | null } } })?.event?.data?.old ??
      (payload as Record<string, unknown> | null | undefined);
    const value = row && typeof row === 'object' ? (row as Record<string, unknown>)[field] : undefined;
    return typeof value === 'string' ? value : undefined;
  };

export function loopPrevention(config: LoopPreventionConfig = {}): EventKitPlugin {
  const field = config.field ?? 'updated_by';
  const serviceId = config.serviceId ?? 'eventkit';
  const codec: TokenCodec = createTokenCodec(config.codec);
  const read = config.read ?? defaultRead(field);

  return {
    name: 'loop-prevention',

    // Inbound: lift the prior token into envelope.meta for detectors/handlers.
    augmentEnvelope(envelope) {
      const inbound = read(envelope);
      if (inbound && codec.isValid(inbound)) {
        return { meta: { ...envelope.meta, sourceTrackingToken: inbound } };
      }
      return undefined;
    },

    // Outbound: deterministic token for jobs to stamp into the write field.
    augmentJobContext(ctx: JobContext) {
      const inbound = ctx.envelope.meta?.['sourceTrackingToken'];
      const token =
        typeof inbound === 'string' && codec.isValid(inbound)
          ? codec.withJobExecutionId(inbound, ctx.job.id)
          : codec.create(serviceId, ctx.correlationId, ctx.job.id);
      return { ambient: { trackingToken: token } };
    },
  };
}
