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

/**
 * A platform-agnostic short-circuit response from a `handler({ before })` pre-check
 * (auth, method gate, …). The `before` hook returns this (or void to proceed); the
 * platform adapter shapes it via `formatRejection`, so the pre-check stays
 * platform-agnostic — a `{ status: 401 }` becomes `{ statusCode, body }` under the
 * classic adapter and a Web `Response` under `netlifyV2Platform`, with no hand-coded
 * coupling to a runtime's response shape.
 */
export interface HandlerShortCircuit {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * The outcome of one registered event during an invocation. Appears for an event
 * that DETECTED, or for one whose DETECTOR threw (so the crash is visible in the
 * returned payload — observability parity with the legacy runtime, which recorded
 * detector/handler/job errors in the response body Hasura logs).
 *
 * Semantics, matching the legacy no-retry contract:
 *  - `detected` is the detector's verdict. A handler crash keeps `detected: true`
 *    (the event WAS detected; the handler is what failed) with `jobs: []` and
 *    `error` set. A detector crash is reported as `detected: false` with `error`.
 *  - `error` is the serialized detector/handler crash, if any. It does NOT flow
 *    into `InvocationResult.ok` — business-logic throws are swallowed and reported,
 *    never retried via a 5xx (that is reserved for the framework itself breaking).
 */
export interface EventOutcome {
  name: string;
  detected: boolean;
  jobs: JobExecution[];
  error?: SerializedError;
}

/** The aggregate outcome of one invocation (§9.7). */
export interface InvocationResult {
  ok: boolean;
  invocationId: InvocationId;
  events: EventOutcome[];
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

  /**
   * Zero-boilerplate entry: the platform adapter owns the runtime signature & response.
   * A `before` pre-check returns a platform-agnostic `HandlerShortCircuit` to reject
   * (shaped by the adapter's `formatRejection`), or `void` to proceed.
   */
  handler(opts?: {
    before?: (...args: unknown[]) => HandlerShortCircuit | void | Promise<HandlerShortCircuit | void>;
  }): (...args: unknown[]) => unknown;
  /** Manual entry: forward raw platform args (the adapter extracts payload + budget). */
  handle(rawPayloadOrArgs: unknown, request?: RequestContext | unknown): Promise<InvocationResult>;
  shutdown(): Promise<void>;
}

// `createEventKit()` (the constructor) lives in `../runtime/kit.ts`. The root
// package re-exports it; this module owns only the frozen `EventKit` contract.
