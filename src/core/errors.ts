// =============================================================================
// Error + output serialization (§9.6)
// =============================================================================
// Core owns serialization because both durability (Batch) and observability
// must persist errors/outputs that may contain circular references or live,
// non-serializable values. These are leaf utilities — pure and dependency-free —
// so they are implemented here in Phase 0 rather than stubbed.

import type { EventName, JobName } from './brands.js';

/** A JSON-safe representation of any thrown value. */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: SerializedError;
  data?: Record<string, unknown>;
}

/** Phase in which an error surfaced, handed to a plugin's `onError`. */
export type ErrorPhase = 'normalize' | 'prepare' | 'detect' | 'handle' | 'job' | 'plugin' | 'chain-guard';

/** Context accompanying an `onError` notification (§11.2). */
export interface ErrorContext {
  error: SerializedError;
  phase: ErrorPhase;
  invocationId: string;
  correlationId: string;
  eventName?: EventName;
  jobName?: JobName;
  /**
   * Absent means 'error' (a failure). `'warn'` marks a NON-FATAL early alarm
   * (ADR-041 `warnAtDepth`): alerting backends may route it at a lower level and
   * observability must NOT treat it as a record failure.
   */
  severity?: 'error' | 'warn';
}

const MAX_CAUSE_DEPTH = 8;

/**
 * Convert any thrown value into a JSON-serializable `SerializedError`.
 * Recurses into `error.cause` (bounded), captures a `code`/`data` when present,
 * and never throws itself.
 */
export function serializeError(error: unknown, _depth = 0): SerializedError {
  if (error instanceof Error) {
    const out: SerializedError = {
      name: error.name || 'Error',
      message: error.message || '',
    };
    if (error.stack) out.stack = error.stack;

    const anyErr = error as Error & { code?: unknown; data?: unknown; cause?: unknown };
    if (typeof anyErr.code === 'string' || typeof anyErr.code === 'number') {
      out.code = String(anyErr.code);
    }
    if (anyErr.data && typeof anyErr.data === 'object') {
      out.data = replaceCircularReferences(anyErr.data) as Record<string, unknown>;
    }
    if (anyErr.cause != null && _depth < MAX_CAUSE_DEPTH) {
      out.cause = serializeError(anyErr.cause, _depth + 1);
    }
    return out;
  }

  if (typeof error === 'string') {
    return { name: 'Error', message: error };
  }

  // Non-Error, non-string (number, object, null, …): describe it safely.
  const out: SerializedError = { name: 'NonError', message: safeStringify(error) };
  if (error && typeof error === 'object') {
    out.data = replaceCircularReferences(error) as Record<string, unknown>;
  }
  return out;
}

/**
 * Make an arbitrary job output safe to persist/record: strip circular references
 * and replace values that cannot survive JSON (functions, symbols, bigint).
 * Returns a structurally-cloned, JSON-safe value.
 */
export function serializeOutput<T>(output: T): unknown {
  return replaceCircularReferences(output);
}

/**
 * Walk a value and return a JSON-safe copy:
 *  - circular references become the string `'[Circular]'`
 *  - functions/symbols become a tagged string
 *  - bigint becomes its decimal string
 *  - Dates are preserved (left as Date; JSON.stringify handles them)
 * Promoted into core from the legacy batchjobs implementation (§9.6).
 */
export function replaceCircularReferences<T>(value: T): unknown {
  const seen = new WeakSet<object>();

  const walk = (val: unknown): unknown => {
    if (val === null) return null;

    const t = typeof val;
    if (t === 'function') return `[Function: ${(val as { name?: string }).name || 'anonymous'}]`;
    if (t === 'symbol') return String(val);
    if (t === 'bigint') return (val as bigint).toString();
    if (t !== 'object') return val; // string | number | boolean | undefined

    if (val instanceof Date) return val;
    if (val instanceof Error) return serializeError(val);

    if (seen.has(val as object)) return '[Circular]';
    seen.add(val as object);

    if (Array.isArray(val)) {
      const arr = val.map(walk);
      seen.delete(val as object);
      return arr;
    }

    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out[k] = walk(v);
    }
    seen.delete(val as object);
    return out;
  };

  return walk(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(replaceCircularReferences(value)) ?? String(value);
  } catch {
    return String(value);
  }
}

// =============================================================================
// Request/response error classes (ADR-026)
// =============================================================================
// Thrown from a module's response fn (or a job) to signal a non-2xx wire reply.
// Carry their mapping data as plain fields so the runtime/platform can read them
// duck-typed (instanceof across bundled module copies is unreliable). The runtime
// surfaces these onto `InvocationResult.resolved.error`; the source's platform
// adapter maps them to the wire (HTTP status / Hasura `{message,extensions}`).

// A registry Symbol so the brand survives across bundled module copies (instanceof
// is unreliable there — same reason ADR-026 duck-types `.status`). `Symbol.for`
// returns the identical symbol from every copy, and symbols are skipped by
// JSON.stringify / object spread, so the brand never leaks into a serialized record.
const CLIENT_ERROR_BRAND = Symbol.for('eventkit/ClientError');

/**
 * Map the outcome to a specific HTTP status. For status-contract webhook vendors
 * (e.g. Stripe), throwing `ClientError(400, …)` makes the platform respond 400.
 */
export class ClientError extends Error {
  override readonly name = 'ClientError';
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    (this as unknown as Record<symbol, unknown>)[CLIENT_ERROR_BRAND] = true;
  }
}

/**
 * True ONLY for an intentional, branded `ClientError` (ADR-033) — even across bundled
 * module copies. The pre-dispatch fast-path uses this instead of a bare `.status`
 * duck-type, so a framework error that merely happens to carry a numeric `.status`
 * (e.g. a DB error from a `correlationResolver` lookup) is NOT mistaken for a
 * deliberate client response.
 */
export function isClientError(err: unknown): err is ClientError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[CLIENT_ERROR_BRAND] === true &&
    typeof (err as { status?: unknown }).status === 'number'
  );
}

/**
 * A Hasura Action error (§7.2). Maps to HTTP 4xx with body
 * `{ message, extensions: { code? } }` — the exact shape Hasura surfaces to the
 * GraphQL client. `code` is optional; extra `extensions` keys are merged.
 */
export class ActionError extends Error {
  override readonly name = 'ActionError';
  readonly code?: string;
  readonly extensions?: Record<string, unknown>;
  constructor(message: string, code?: string, extensions?: Record<string, unknown>) {
    super(message);
    if (code !== undefined) this.code = code;
    if (extensions !== undefined) this.extensions = extensions;
  }
}

// =============================================================================
// Loop-halt error (ADR-041)
// =============================================================================
// A halted chain is a first-class, loud event. When the hop ceiling suppresses
// dispatch, the runtime reports THIS branded error through `onError` (phase
// 'chain-guard') so any alerting backend routes on the brand without bespoke
// wiring; `warnAtDepth` reports the same error non-fatally (severity 'warn').
// Brand-checked like ClientError (a registry Symbol survives bundled module copies).
// The detail rides `.data` so the existing serializeError carries it into
// SerializedError.data with zero extra wiring.
const LOOP_DETECTED_ERROR_BRAND = Symbol.for('eventkit/LoopDetectedError');

/** The halted-chain detail carried on `LoopDetectedError.data` (and its readonly fields). */
export interface LoopDetectedDetail {
  correlationId: string;
  depth: number;
  ceiling: number;
  serviceId: string;
  sourceFunction?: string;
}

/**
 * Thrown/reported when a chain's hop depth reaches its ceiling (`haltAtDepth`,
 * ADR-034/041). Fields mirror `LoopDetectedDetail`; `.data` (a plain object) makes
 * the detail survive `serializeError` into `SerializedError.data` untouched.
 */
export class LoopDetectedError extends Error {
  override readonly name = 'LoopDetectedError';
  readonly correlationId: string;
  readonly depth: number;
  readonly ceiling: number;
  readonly serviceId: string;
  readonly sourceFunction?: string;
  readonly data: Record<string, unknown>;
  constructor(message: string, detail: LoopDetectedDetail) {
    super(message);
    this.correlationId = detail.correlationId;
    this.depth = detail.depth;
    this.ceiling = detail.ceiling;
    this.serviceId = detail.serviceId;
    if (detail.sourceFunction !== undefined) this.sourceFunction = detail.sourceFunction;
    this.data = { ...detail };
    (this as unknown as Record<symbol, unknown>)[LOOP_DETECTED_ERROR_BRAND] = true;
  }
}

/**
 * True ONLY for a branded `LoopDetectedError` — even across bundled module copies
 * (same cross-copy rationale as `isClientError`). `onError` subscribers route on
 * this brand; note that `onError` receives the SERIALIZED error, so a subscriber
 * inside the fan-out must brand-check the live throw, not the serialized copy.
 */
export function isLoopDetectedError(err: unknown): err is LoopDetectedError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as Record<symbol, unknown>)[LOOP_DETECTED_ERROR_BRAND] === true
  );
}
