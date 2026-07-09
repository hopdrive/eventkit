// =============================================================================
// eventkit — platform adapter shared helpers
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

/**
 * Query params as a flat string map. Classic/lambda events expose
 * `queryStringParameters`; a v2 `Request` exposes them via its URL. Some vendor
 * webhooks key their signature/token on a query param, so `verify` needs these.
 */
export const queryOf = (event: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  const qsp = (event as { queryStringParameters?: Record<string, unknown> | null } | undefined)?.queryStringParameters;
  if (qsp && typeof qsp === 'object') {
    for (const [k, v] of Object.entries(qsp)) if (v != null) out[k] = String(v);
    return out;
  }
  const url = (event as { url?: unknown } | undefined)?.url;
  if (typeof url === 'string') {
    try {
      new URL(url).searchParams.forEach((v, k) => { out[k] = v; });
    } catch {
      // not an absolute URL — leave query empty
    }
  }
  return out;
};

/** Stash headers, query params (+ raw body when available) on RequestContext.meta so sources (e.g. webhook) can read them. */
export const requestMeta = (event: unknown): Record<string, unknown> => {
  const meta: Record<string, unknown> = { headers: extractHeaders(event), query: queryOf(event) };
  const raw = rawBodyOf(event);
  if (raw !== undefined) meta['rawBody'] = raw;
  return meta;
};

// A Web `Request` body is a one-shot stream, and the v2 adapters need BOTH the
// parsed body (payload for detectors) AND the exact bytes (`rawBody` for HMAC
// signature verification). So `extractV2Payload` reads the body ONCE as text,
// caches the exact string keyed by the request (WeakMap — no mutation of the
// Request, GC-friendly), and returns the parsed JSON; `v2Meta` then exposes the
// cached bytes as `meta.rawBody`. The runtime calls extractPayload before
// buildRequest with the same request instance, so the cache is populated in time.
const V2_RAW_BODY = new WeakMap<object, string>();

/** Read a v2 Web `Request` body once: cache exact bytes for `rawBody`, return parsed JSON (or the raw string if not JSON, or undefined for an empty body). */
export const extractV2Payload = async (request: unknown): Promise<unknown> => {
  const req = request as { text?: () => Promise<string>; json?: () => Promise<unknown> } | undefined;
  if (req && typeof req.text === 'function') {
    const raw = await req.text();
    if (request && typeof request === 'object') V2_RAW_BODY.set(request, raw);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return raw; // non-JSON body — hand the source the raw string
    }
  }
  if (req && typeof req.json === 'function') return req.json();
  return req;
};

/** RequestContext.meta for a v2 `Request`: headers + query + the `rawBody` cached by `extractV2Payload` (needed for HMAC verify). */
export const v2Meta = (request: unknown): Record<string, unknown> => {
  const meta: Record<string, unknown> = { headers: extractHeaders(request), query: queryOf(request) };
  const raw = request && typeof request === 'object' ? V2_RAW_BODY.get(request) : undefined;
  if (raw !== undefined) meta['rawBody'] = raw;
  return meta;
};

/** Serialize a produced response body: a string passes through, anything else is JSON. */
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
 * HTTP {statusCode, headers?, body} honoring a request/response module's `response` (ADR-026):
 *   - framework error       → 500 + ack body (retryable)
 *   - response fn threw     → ClientError status (or 400) + {message, extensions?}
 *   - response produced     → declared `ResponseWire` status (default 200) + headers + the output
 *   - no response declared  → 200 + the fire-and-forget ack body (unchanged)
 */
export const httpResponse = (
  result: InvocationResult,
): { statusCode: number; body: string; headers?: Record<string, string> } => {
  if (result.error) return { statusCode: 500, body: jsonBody(result) };
  const r = result.resolved;
  if (r?.error) return { statusCode: r.error.status ?? 400, body: errorBody(r.error) };
  if (r?.hasResolved) {
    return {
      statusCode: r.status ?? 200,
      body: outputBody(r.output),
      ...(r.headers ? { headers: r.headers } : {}),
    };
  }
  return { statusCode: 200, body: jsonBody(result) };
};

/** HTTP-style short-circuit (classic/lambda/background): { statusCode, body }. */
export const httpRejection = (r: HandlerShortCircuit) => ({ statusCode: r.status, body: r.body ?? '' });

/** Web-`Response` short-circuit (the v2 adapters) — a hand-shaped `{ statusCode }` would be a malformed v2 reply. */
export const webRejection = (r: HandlerShortCircuit): Response =>
  new Response(r.body ?? '', { status: r.status, headers: r.headers ?? {} });

export const env = (): Record<string, string | undefined> =>
  typeof process !== 'undefined' && process.env ? process.env : {};
