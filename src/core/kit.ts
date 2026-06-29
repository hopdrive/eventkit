// =============================================================================
// EventKit: per-invocation entry point (§9.7, ADR-013, ADR-019)
// =============================================================================

import type { InvocationId } from './brands.js';
import type { RequestContext } from './context.js';
import type { EventModule } from './event-module.js';
import type { JobExecution } from './job.js';
import type { SerializedError } from './errors.js';
import type { EventKitPlugin } from './plugin.js';

/** A plugin factory the kit instantiates itself (D22 — lazily). */
export type PluginFactory = (config?: unknown) => EventKitPlugin;

/** The aggregate outcome of one invocation (§9.7). */
export interface InvocationResult {
  ok: boolean;
  invocationId: InvocationId;
  events: Array<{ name: string; detected: boolean; jobs: JobExecution[] }>;
  durationMs: number;
  timedOut?: boolean;
  error?: SerializedError;
}

/**
 * A module-scoped runtime built once per warm lambda. The required source is
 * `createEventKit`'s first positional arg (ADR-019, D19=C); everything else —
 * the optional platform and all observer/transform plugins — registers via
 * `use(plugin, config?)`.
 */
export interface EventKit {
  /**
   * Register a plugin/factory (NOT a call) plus optional config; the kit
   * instantiates it (§11.4). A bare already-constructed plugin is also accepted.
   * Chainable.
   */
  use(plugin: EventKitPlugin | PluginFactory, config?: unknown): EventKit;
  registerEvent(module: EventModule): EventKit;
  registerEvents(modules: EventModule[] | Record<string, EventModule>): EventKit;
  /** Explicit validation; also run on first `handle()`. Throws on misconfig. */
  validate(): void;

  /** Zero-boilerplate entry: the platform adapter owns the runtime signature & response. */
  handler(opts?: { before?: (...args: unknown[]) => unknown }): (...args: unknown[]) => unknown;
  /** Manual entry: forward raw platform args (the adapter extracts payload + budget). */
  handle(rawPayloadOrArgs: unknown, request?: RequestContext | unknown): Promise<InvocationResult>;
  shutdown(): Promise<void>;
}

// `createEventKit()` (the constructor) lives in `../runtime/kit.ts`. The root
// package re-exports it; this module owns only the frozen `EventKit` contract.
