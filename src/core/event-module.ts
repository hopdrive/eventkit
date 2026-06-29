// =============================================================================
// Event modules (§18)
// =============================================================================
// Each module exports exactly one detector and one handler (§3.5). The detector
// answers "did this business event occur for this invocation?"; the handler
// declares the (unconditional) jobs that run when it did.

import type { EventName } from './brands.js';
import type { DetectorContext } from './context.js';
import type { HandlerContext } from './context.js';
import type { DetectedEvent } from './envelope.js';
import type { JobExecution } from './job.js';

export type DetectorFunction<
  TPayload = unknown,
  TSourceContext = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> = (ctx: DetectorContext<TPayload, TSourceContext, TMeta>) => boolean | Promise<boolean>;

export type HandlerFunction<
  TPayload = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> = (
  event: DetectedEvent<TPayload, TMeta>,
  ctx: HandlerContext<TPayload, TMeta>,
) => Promise<JobExecution[] | void> | JobExecution[] | void;

/**
 * Optional, registration-time metadata on a module. Feeds static analysis, Flow
 * hints, and the Console. Distinct from runtime `DetectedEvent.metadata`. Nothing
 * depends on it at runtime (D18).
 */
export interface EventModuleMetadata {
  description?: string;
  tags?: string[];
  owner?: string;
  /** Hints the Flow tooling uses to place this event in an Expected Flow. */
  flowHints?: Record<string, unknown>;
  deprecated?: boolean;
  relatedDocs?: string[];
}

/** A registered event module (§3.4 — explicit registration only). */
export interface EventModule<
  TPayload = unknown,
  TSourceContext = unknown,
  TMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  name: EventName;
  detector: DetectorFunction<TPayload, TSourceContext, TMeta>;
  handler: HandlerFunction<TPayload, TMeta>;
  metadata?: EventModuleMetadata;
}
