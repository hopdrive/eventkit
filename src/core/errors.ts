// =============================================================================
// Error + output serialization (§9.6)
// =============================================================================
// Core owns serialization because both durability (BatchJobs) and observability
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
export type ErrorPhase = 'normalize' | 'detect' | 'handle' | 'job' | 'plugin';

/** Context accompanying an `onError` notification (§11.2). */
export interface ErrorContext {
  error: SerializedError;
  phase: ErrorPhase;
  invocationId: string;
  correlationId: string;
  eventName?: EventName;
  jobName?: JobName;
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
