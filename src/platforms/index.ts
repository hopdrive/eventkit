// =============================================================================
// @hopdrive/eventkit/platforms
// =============================================================================
// Platform adapters (§9.8, ADR-021). Optional capability providers registered via
// `kit.use(netlifyPlatform)`. They are the ONLY place that touches platform
// specifics: invocation signature, payload extraction, time budget, response shape.
// Event modules, handlers, jobs, and other plugins stay platform-agnostic.
//
// Time-budget strategy collapses to three buckets, all surfaced as
// `RequestContext.getRemainingTimeMs`:
//   A — native countdown (Lambda, Netlify classic, Netlify background)
//   B — computed deadline from a configured max (Vercel, Netlify v2)
//   C — none (long-running servers, local/test)
import type { HandlerShortCircuit, InvocationResult, PlatformAdapter, RequestContext, ResolvedError } from '../core/index.js';

// ── Shared helpers ───────────────────────────────────────────────────────────

interface LambdaContext {
  getRemainingTimeInMillis?: () => number;
  functionName?: string;
  awsRequestId?: string;
}

/** Normalize request headers (plain object or a Web `Headers`) to a lowercase-keyed map. */
const extractHeaders = (src: unknown): Record<string, string> => {
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
const requestMeta = (event: unknown): Record<string, unknown> => {
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
const extractHttpBody = (event: unknown): unknown => {
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
const nativeCountdown = (context: LambdaContext | undefined): (() => number) | undefined =>
  typeof context?.getRemainingTimeInMillis === 'function' ? () => context.getRemainingTimeInMillis!() : undefined;

/** Bucket B: computed deadline anchored at call time. */
const computedDeadline = (maxExecutionMs: number): (() => number) => {
  const startedAt = Date.now();
  return () => Math.max(0, maxExecutionMs - (Date.now() - startedAt));
};

const jsonBody = (result: InvocationResult): string =>
  JSON.stringify({
    ok: result.ok,
    invocationId: result.invocationId,
    events: result.events.map(e => ({ name: e.name, detected: e.detected, jobs: e.jobs.length })),
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.error ? { error: result.error.message } : {}),
  });

/**
 * HTTP {statusCode, body} honoring a request/response module's `resolve` (ADR-026):
 *   - framework error      → 500 + ack body (retryable)
 *   - resolve threw         → ClientError status (or 400) + {message, extensions?}
 *   - resolve returned      → 200 + the output (status-contract ack, e.g. Stripe)
 *   - no resolve            → 200 + the fire-and-forget ack body (unchanged)
 */
const httpResponse = (result: InvocationResult): { statusCode: number; body: string } => {
  if (result.error) return { statusCode: 500, body: jsonBody(result) };
  const r = result.resolved;
  if (r?.error) return { statusCode: r.error.status ?? 400, body: errorBody(r.error) };
  if (r?.hasResolved) return { statusCode: 200, body: outputBody(r.output) };
  return { statusCode: 200, body: jsonBody(result) };
};

// HTTP-style short-circuit (classic/lambda/background): { statusCode, body }.
const httpRejection = (r: HandlerShortCircuit) => ({ statusCode: r.status, body: r.body ?? '' });

const env = (): Record<string, string | undefined> =>
  typeof process !== 'undefined' && process.env ? process.env : {};

// ── lambdaPlatform — raw AWS Lambda (event, context); bucket A ───────────────
export function lambdaPlatform(): PlatformAdapter {
  return {
    name: 'lambda-platform',
    provides: ['platform', 'platform:lambda'],
    detect: () => !!env()['AWS_LAMBDA_FUNCTION_NAME'],
    extractPayload: (event: unknown) => extractHttpBody(event),
    buildRequest: (event: unknown, context?: LambdaContext): RequestContext => {
      const req: RequestContext = { meta: requestMeta(event) };
      const get = nativeCountdown(context);
      if (get) req.getRemainingTimeMs = get;
      if (context?.functionName) req.sourceFunction = context.functionName;
      return req;
    },
    formatResponse: (result: InvocationResult) => httpResponse(result),
    formatRejection: httpRejection,
  };
}

// ── netlifyPlatform — Netlify classic Functions (event, context); bucket A ───
export function netlifyPlatform(): PlatformAdapter {
  return {
    name: 'netlify-platform',
    provides: ['platform', 'platform:netlify'],
    detect: () => !!env()['NETLIFY'],
    extractPayload: (event: unknown) => extractHttpBody(event),
    buildRequest: (event: unknown, context?: LambdaContext): RequestContext => {
      const req: RequestContext = { meta: requestMeta(event) };
      const get = nativeCountdown(context);
      if (get) req.getRemainingTimeMs = get;
      const fn = context?.functionName ?? (event as { path?: string })?.path;
      if (fn) req.sourceFunction = fn;
      return req;
    },
    formatResponse: (result: InvocationResult) => httpResponse(result),
    formatRejection: httpRejection,
  };
}

// ── netlifyBackgroundPlatform — Background Functions; 202, bucket A long budget ─
// Powers the live batch_jobs watch view (~15-min budget). The HTTP response is 202
// immediately; the return body is ignored by the platform.
export function netlifyBackgroundPlatform(config: { maxExecutionMs?: number } = {}): PlatformAdapter {
  const maxExecutionMs = config.maxExecutionMs ?? 15 * 60 * 1000;
  return {
    name: 'netlify-background-platform',
    provides: ['platform', 'platform:netlify-background'],
    detect: () => !!env()['NETLIFY'],
    extractPayload: (event: unknown) => extractHttpBody(event),
    buildRequest: (_event: unknown, context?: LambdaContext): RequestContext => {
      const req: RequestContext = { getRemainingTimeMs: nativeCountdown(context) ?? computedDeadline(maxExecutionMs) };
      if (context?.functionName) req.sourceFunction = context.functionName;
      return req;
    },
    formatResponse: () => ({ statusCode: 202 }),
    // A rejection (auth/method) is NOT a successful dispatch — return its real status, not 202.
    formatRejection: httpRejection,
  };
}

// ── netlifyV2Platform — modern v2 (Request, Context) → Response; bucket B ─────
// D21: treated as bucket B (computed deadline) unless a v2 context is confirmed to
// expose a live countdown. `maxExecutionMs` is the configured wall limit.
export function netlifyV2Platform(config: { maxExecutionMs?: number } = {}): PlatformAdapter {
  const maxExecutionMs = config.maxExecutionMs ?? 10_000;
  return {
    name: 'netlify-v2-platform',
    provides: ['platform', 'platform:netlify-v2'],
    detect: () => !!env()['NETLIFY'],
    extractPayload: async (request: unknown) => {
      const req = request as { json?: () => Promise<unknown> } | undefined;
      if (req && typeof req.json === 'function') return req.json();
      return req;
    },
    buildRequest: (request?: unknown): RequestContext => ({
      getRemainingTimeMs: computedDeadline(maxExecutionMs),
      // v2 can't preserve rawBody (extractPayload consumed it via .json()); headers are fine.
      meta: { headers: extractHeaders(request) },
    }),
    formatResponse: (result: InvocationResult) => {
      const { statusCode, body } = httpResponse(result);
      return new Response(body, { status: statusCode, headers: { 'content-type': 'application/json' } });
    },
    // v2 needs a Web Response — a hand-shaped { statusCode } would be a malformed reply.
    formatRejection: (r: HandlerShortCircuit) => new Response(r.body ?? '', { status: r.status, headers: r.headers ?? {} }),
  };
}

// ── hasuraActionPlatform — Hasura Actions request/response (§7.2, ADR-026) ────
// Classic Netlify/Lambda style ({ statusCode, body }). Hasura POSTs the action
// invocation as JSON and returns the handler's body to the GraphQL client synchronously:
//   success → 2xx + the module's `resolve` output (the action's declared output type)
//   error   → 4xx + { message, extensions: { code? } }   (a thrown ActionError/ClientError)
// A `before`-hook rejection (auth) maps to its status + { message } so Hasura surfaces it.
const actionResponse = (result: InvocationResult): { statusCode: number; body: string } => {
  if (result.error) return { statusCode: 500, body: JSON.stringify({ message: result.error.message }) };
  const r = result.resolved;
  if (r?.error) return { statusCode: r.error.status ?? 400, body: errorBody(r.error) };
  if (r?.hasResolved) return { statusCode: 200, body: outputBody(r.output) };
  // No `resolve` declared — an action must return its output type, so there is nothing
  // to send. (A fire-and-forget action is unusual; return an empty object as the body.)
  return { statusCode: 200, body: '{}' };
};

export function hasuraActionPlatform(): PlatformAdapter {
  return {
    name: 'hasura-action-platform',
    provides: ['platform', 'platform:hasura-action'],
    detect: () => !!env()['NETLIFY'] || !!env()['AWS_LAMBDA_FUNCTION_NAME'],
    extractPayload: (event: unknown) => extractHttpBody(event),
    buildRequest: (event: unknown, context?: LambdaContext): RequestContext => {
      const req: RequestContext = { meta: requestMeta(event) };
      const get = nativeCountdown(context);
      if (get) req.getRemainingTimeMs = get;
      if (context?.functionName) req.sourceFunction = context.functionName;
      return req;
    },
    formatResponse: (result: InvocationResult) => actionResponse(result),
    // Hasura reads `message` from a non-2xx body; shape the auth/method short-circuit that way.
    formatRejection: (r: HandlerShortCircuit) => ({ statusCode: r.status, body: JSON.stringify({ message: r.body ?? 'Unauthorized' }) }),
  };
}
