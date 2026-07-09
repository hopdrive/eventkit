// =============================================================================
// EventKit: per-invocation entry point (§9.7, ADR-013, ADR-019)
// =============================================================================

import type { InvocationId } from './brands.js';
import type { RequestContext } from './context.js';
import type { EventModule } from './event-module.js';
import type { JobExecution } from './job.js';
import type { SerializedError } from './errors.js';
import type { EventKitPlugin } from './plugin.js';
import type { KitDescription } from './flow.js';

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
 * The raw HTTP invocation event handed to a `before` pre-check under the HTTP
 * platform adapters (classic / lambda / background). Loose by design — every field
 * is optional so the same shape works across Lambda v1, Netlify classic, and local
 * `netlify dev`. The `netlifyV2Platform` adapter instead receives a Web `Request`;
 * type that case explicitly via `handler<[Request]>({ before })`.
 */
export interface HttpRequestEvent {
  httpMethod?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
  queryStringParameters?: Record<string, string | undefined> | null;
  path?: string;
  rawUrl?: string;
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

/**
 * The value a module's `response` declaration produced (ADR-026), surfaced so the
 * source's platform adapter can map it to the wire. Exactly one of `output` (the
 * response fn returned / the `static` body) or `error` (the fn, or the `prepare`
 * before it, threw) is set.
 */
export interface ResolvedOutcome {
  /** The produced success body. `hasResolved` distinguishes a produced `undefined` from "no response declared". */
  output?: unknown;
  /** True when a response was produced (success or error) — lets the platform tell "produced undefined" from a fire-and-forget invocation. */
  hasResolved: boolean;
  /** Set when the response fn (or the `prepare` before it) threw — mapping data for the error reply. */
  error?: ResolvedError;
  /** Declared success status from the module's `response` (`ResponseWire`); platform default (200) when absent. */
  status?: number;
  /** Declared response headers from the module's `response` (`ResponseWire`); merged over the platform default. */
  headers?: Record<string, string>;
}

/** A response-fn/`prepare` throw, with the fields a platform maps to the wire error. */
export interface ResolvedError {
  message: string;
  /** From a thrown `ClientError(status, …)` — the exact HTTP status to respond with. */
  status?: number;
  /** From a thrown `ActionError(message, code?)` — Hasura's `extensions.code`. */
  code?: string;
  /** Extra `extensions` keys from an `ActionError`. */
  extensions?: Record<string, unknown>;
}

/** The aggregate outcome of one invocation (§9.7). */
export interface InvocationResult {
  ok: boolean;
  invocationId: InvocationId;
  events: EventOutcome[];
  durationMs: number;
  timedOut?: boolean;
  error?: SerializedError;
  /**
   * The request/response value (ADR-026), if a detected module declared a `response`. The
   * FIRST detected module with one provides it; fire-and-forget invocations leave
   * it undefined. The source's platform adapter reads this to shape the wire response.
   */
  resolved?: ResolvedOutcome;
}

/**
 * A module-scoped runtime built once per warm lambda. The required source is
 * `createEventKit`'s first positional arg (ADR-019, D19=C); everything else —
 * the optional platform and all observer/transform plugins — registers via
 * `use(plugin, config?)`.
 */
/** One event's verdict from `kit.dryRun()` — detected + the jobs it would dispatch. */
export interface DryRunEvent {
  name: string;
  detected: boolean;
  /** The declared job names this event would dispatch if it fired (static, ADR-025). */
  jobs: string[];
  /** Present if the detector threw. */
  error?: string;
}

/** The result of `kit.dryRun()` — detection only, no jobs run. */
export interface DryRunResult {
  invocationId: string;
  correlationId: string;
  /** Events whose detector fired (or threw). Clean non-matches are omitted. */
  events: DryRunEvent[];
}

export interface EventKit {
  /**
   * Register a plugin/factory (NOT a call) plus optional config; the kit
   * instantiates it (§11.4). A bare already-constructed plugin is also accepted.
   * Chainable.
   */
  use(plugin: EventKitPlugin | PluginFactory, config?: unknown): EventKit;
  /**
   * Accepts a module with ANY payload/meta/prepared typing (`EventModule<any, any, any>`),
   * so a source-typed module — `hasuraEvent.defineEvent<Row>(…)`, a typed `defineEvent`
   * — registers without a variance cast. The kit stores modules heterogeneously; the
   * per-module types did their work at authoring time.
   */
  registerEvent(module: EventModule<any, any, any>): EventKit;
  registerEvents(modules: EventModule<any, any, any>[] | Record<string, EventModule<any, any, any>>): EventKit;
  /** Explicit validation; also run on first `handle()`. Throws on misconfig. */
  validate(): void;

  /**
   * Zero-boilerplate entry: the platform adapter owns the runtime signature & response.
   * A `before` pre-check returns a platform-agnostic `HandlerShortCircuit` to reject
   * (shaped by the adapter's `formatRejection`), or `void` to proceed.
   */
  handler<TArgs extends unknown[] = [HttpRequestEvent, ...unknown[]]>(opts?: {
    before?: (...args: TArgs) => HandlerShortCircuit | void | Promise<HandlerShortCircuit | void>;
  }): (...args: unknown[]) => unknown;
  /** Manual entry: forward raw platform args (the adapter extracts payload + budget). */
  handle(rawPayloadOrArgs: unknown, request?: RequestContext | unknown): Promise<InvocationResult>;
  /**
   * Run detection ONLY against a payload (normalize → augment → detect) and report which
   * events would fire and the jobs they'd dispatch — WITHOUT running any job or response
   * seam. Near-pure (side effects live in jobs, which don't run). Powers `eventkit-flow
   * simulate` and consumer "would this fire?" tests.
   */
  dryRun(rawPayloadOrArgs: unknown, request?: RequestContext | unknown): Promise<DryRunResult>;
  shutdown(): Promise<void>;

  /**
   * Read-only structural snapshot of the kit: its source, platform, plugins, and
   * every registered event with its static job set (§14–§16). Pure — resolves
   * plugins but runs nothing. Feeds the flow generator (`eventkit/flow`).
   */
  describe(): KitDescription;
}

// `createEventKit()` (the constructor) lives in `../runtime/kit.ts`. The root
// package re-exports it; this module owns only the frozen `EventKit` contract.
