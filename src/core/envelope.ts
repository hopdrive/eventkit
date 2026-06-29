// =============================================================================
// EventEnvelope + DetectedEvent (§9.1)
// =============================================================================

import type { EventName, EventSourceName, InvocationId, CorrelationId } from './brands.js';

/**
 * The kind of source that produced an envelope. `'manual'` and `'queue'` are
 * first-class (§7). A Hasura DB trigger is `'database'`; a Hasura scheduled
 * trigger is `'cron'` (ADR-023).
 */
export type EventSourceType = 'database' | 'webhook' | 'cron' | 'application' | 'queue' | 'manual';

/**
 * Normalized representation of *what came in*. Source-agnostic: it MUST NOT
 * expose source helpers like `columnChanged()` (those live on the source's
 * DetectorContext). `meta` carries cross-cutting annotations — notably
 * `sourceTrackingToken` for loop prevention (§13), contributed by a plugin via
 * `augmentEnvelope`/`configureInvocation`, never by mutating the payload.
 */
export interface EventEnvelope<TPayload = unknown, TMeta extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  source: EventSourceName;
  sourceType: EventSourceType;
  receivedAt: Date;
  correlationId: CorrelationId;
  payload: TPayload;
  meta: TMeta;
  /** The original, untouched source payload, retained for debugging/observability. */
  raw?: unknown;
}

/**
 * Produced when a detector returns true: a normalized business event.
 * Intentionally does NOT carry the DetectorContext (ADR-007) — it is a fact,
 * not the machinery that discovered it.
 */
export interface DetectedEvent<TPayload = unknown, TMeta extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  name: EventName;
  invocationId: InvocationId;
  correlationId: CorrelationId;
  source: EventSourceName;
  sourceType: EventSourceType;
  detectedAt: Date;
  detectorDurationMs: number;
  envelope: EventEnvelope<TPayload, TMeta>;
  /** Runtime metadata about this detection, distinct from registration-time `EventModule.metadata`. */
  metadata?: Record<string, unknown>;
}
