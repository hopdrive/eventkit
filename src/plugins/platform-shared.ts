// =============================================================================
// @hopdrive/eventkit — platform adapter shared helpers
// =============================================================================
// Helpers common to the platform flavors (lambda / netlify / netlify-background /
// netlify-v2). Each platform lives in its own folder (§11.0, ADR-027) and imports
// what it needs from here. Platform adapters are the ONLY place that touches
// platform specifics: invocation signature, payload extraction, time budget,
// response shape. Event modules, handlers, jobs, and other plugins stay agnostic.
//
// Time-budget strategy collapses to three buckets, all surfaced as
// `RequestContext.getRemainingTimeMs`:
//   A — native countdown (Lambda, Netlify classic, Netlify background)
//   B — computed deadline from a configured max (Vercel, Netlify v2)
//   C — none (long-running servers, local/test)
import type { HandlerShortCircuit, InvocationResult, ResolvedError } from '../core/index.js';

export interface LambdaContext {
  getRemainingTimeInMillis?: () => number;
  functionName?: string;
  awsRequestId?: string;
}

/** Normalize request headers (plain object or a Web `Headers`) to a lowercase-keyed map. */
export const extractHeaders = (src: unknown): Record<string, string> => {
  const h = (src as { headers?: unknown } | undefined)?.headers;
  if (!h) return {};
  const out: Record<string, string> = {};
  // Web `Headers` (v2 Request) — iterate via forEach; keys already lowercased.
  if (typeof (h as Headers).forEach === 'function' && typeof (h as Headers).get === 'function') {
    (h as Headers).forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  if (typeof h === 'object') {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (v != null) out[k.toLowerCase()] = String(v);
    }
  }
  return out;
};

/** The unparsed body string (classic/lambda preserve it on `event.body`; v2 does not). */
const rawBodyOf = (event: unknown): string | undefined => {
  const b = (event as { body?: unknown } | undefined)?.body;
  return typeof b === 'string' ? b : undefined;
};

/** Stash headers (+ raw body when available) on RequestContext.meta so sources (e.g. webhook) can read them. */
export const requestMeta = (event: unknown): Record<string, unknown> => {
  const meta: Record<string, unknown> = { headers: extractHeaders(event) };
  const raw = rawBodyOf(event);
  if (raw !== undefined) meta['rawBody'] = raw;
  return meta;
};

/** Serialize a `resolve` success body: a string passes through, anything else is JSON. */
const outputBody = (output: unknown): string => (typeof output === 'string' ? output : JSON.stringify(output ?? null));

/** A generic `{ message, extensions? }` error body (Stripe ignores it; Hasura reads `message`). */
const errorBody = (e: ResolvedError): string =>
  JSON.stringify({
    message: e.message,
    ...(e.code || e.extensions ? { extensions: { ...(e.code ? { code: e.code } : {}), ...(e.extensions ?? {}) } } : {}),
  });

/** Parse an HTTP-style body (string JSON) or pass through an already-structured payload. */
export const extractHttpBody = (event: unknown): unknown => {
  if (event && typeof event === 'object' && 'body' in event) {
    const body = (event as { body?: unknown }).body;
    if (typeof body === 'string') {
      try {
        return JSON.parse(body);
      } catch {
        return body;
      }
    }
    return body ?? event;
  }
  return event;
};

/** Bucket A: native countdown from the Lambda-style context. */
export const nativeCountdown = (context: LambdaContext | undefined): (() => number) | undefined =>
  typeof context?.getRemainingTimeInMillis === 'function' ? () => context.getRemainingTimeInMillis!() : undefined;

/** Bucket B: computed deadline anchored at call time. */
export const computedDeadline = (maxExecutionMs: number): (() => number) => {
  const startedAt = Date.now();
  return () => Math.max(0, maxExecutionMs - (Date.now() - startedAt));
};

const jsonBody = (result: InvocationResult): string =>
  JSON.stringify({
    ok: result.ok,
    invocationId: result.invocationId,
    events: result.events.map(e => ({ name: e.name, detected: e.detected, jobs: e.jobs.length })),
    ...(result.timedOut ? { timedOut: true } : {}),
    // `message` (alongside `error`) makes a framework-error 500 readable by callers that
    // expect a `{ message }` body — e.g. Hasura Actions (which now use these generic HTTP
    // platforms, not a dedicated adapter; ADR-026 amended).
    ...(result.error ? { error: result.error.message, message: result.error.message } : {}),
  });

/**
 * HTTP {statusCode, body} honoring a request/response module's `resolve` (ADR-026):
 *   - framework error      → 500 + ack body (retryable)
 *   - resolve threw         → ClientError status (or 400) + {message, extensions?}
 *   - resolve returned      → 200 + the output (status-contract ack, e.g. Stripe)
 *   - no resolve            → 200 + the fire-and-forget ack body (unchanged)
 */
export const httpResponse = (result: InvocationResult): { statusCode: number; body: string } => {
  if (result.error) return { statusCode: 500, body: jsonBody(result) };
  const r = result.resolved;
  if (r?.error) return { statusCode: r.error.status ?? 400, body: errorBody(r.error) };
  if (r?.hasResolved) return { statusCode: 200, body: outputBody(r.output) };
  return { statusCode: 200, body: jsonBody(result) };
};

/** HTTP-style short-circuit (classic/lambda/background): { statusCode, body }. */
export const httpRejection = (r: HandlerShortCircuit) => ({ statusCode: r.status, body: r.body ?? '' });

export const env = (): Record<string, string | undefined> =>
  typeof process !== 'undefined' && process.env ? process.env : {};
