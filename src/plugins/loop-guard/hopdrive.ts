// =============================================================================
// eventkit/plugins/loop-guard — hopdriveLoopGuard preset (ADR-039.6)
// =============================================================================
// The shared HopDrive preset the RFC promised (§13) but never built. It pins the
// wire format so a repo can't drift or typo it: separator `'|'` and
// `validateCorrelationId: true` (safe now that ADR-040 accepts a 32-hex dashless
// trace-id root). One-object import → the wire format is the path of least
// resistance, not a per-repo literal.
//
// It pairs with the Hasura source defaults, which live on the SOURCE config
// (ADR-039.2): the write field `'updated_by'` and the session variable
// `'x-hasura-tracking-token'` — the two channels the source reads to surface
// `meta.tokenCandidates`. This preset owns only the codec + service identity;
// the source owns payload anatomy.
import type { EventKitPlugin } from '../../core/index.js';
import { loopGuard, type LoopGuardConfig } from './index.js';

export interface HopdriveLoopGuardConfig extends Omit<LoopGuardConfig, 'codec' | 'serviceId'> {
  /** REQUIRED — this service's identity, the token `source` when minting. */
  serviceId: string;
}

export function hopdriveLoopGuard(config: HopdriveLoopGuardConfig): EventKitPlugin {
  if (!config || typeof config.serviceId !== 'string' || config.serviceId.length === 0) {
    throw new Error('hopdriveLoopGuard() requires a non-empty `serviceId`.');
  }
  return loopGuard({
    ...config,
    serviceId: config.serviceId,
    codec: { separator: '|', validateCorrelationId: true },
  });
}
