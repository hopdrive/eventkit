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
import type { InvocationResult, PlatformAdapter, RequestContext } from '../core/index.js';

// ── Shared helpers ───────────────────────────────────────────────────────────

interface LambdaContext {
  getRemainingTimeInMillis?: () => number;
  functionName?: string;
  awsRequestId?: string;
}

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

// A fatal (framework-level) error → 5xx so the platform/Hasura MAY retry; a normal
// invocation (even with failed business jobs) → 200, preserving the no-retry contract.
const httpStatus = (result: InvocationResult): number => (result.error ? 500 : 200);

const env = (): Record<string, string | undefined> =>
  typeof process !== 'undefined' && process.env ? process.env : {};

// ── lambdaPlatform — raw AWS Lambda (event, context); bucket A ───────────────
export function lambdaPlatform(): PlatformAdapter {
  return {
    name: 'lambda-platform',
    provides: ['platform', 'platform:lambda'],
    detect: () => !!env()['AWS_LAMBDA_FUNCTION_NAME'],
    extractPayload: (event: unknown) => extractHttpBody(event),
    buildRequest: (_event: unknown, context?: LambdaContext): RequestContext => {
      const req: RequestContext = {};
      const get = nativeCountdown(context);
      if (get) req.getRemainingTimeMs = get;
      if (context?.functionName) req.sourceFunction = context.functionName;
      return req;
    },
    formatResponse: (result: InvocationResult) => ({ statusCode: httpStatus(result), body: jsonBody(result) }),
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
      const req: RequestContext = {};
      const get = nativeCountdown(context);
      if (get) req.getRemainingTimeMs = get;
      const fn = context?.functionName ?? (event as { path?: string })?.path;
      if (fn) req.sourceFunction = fn;
      return req;
    },
    formatResponse: (result: InvocationResult) => ({ statusCode: httpStatus(result), body: jsonBody(result) }),
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
    buildRequest: (): RequestContext => ({ getRemainingTimeMs: computedDeadline(maxExecutionMs) }),
    formatResponse: (result: InvocationResult) =>
      new Response(jsonBody(result), {
        status: httpStatus(result),
        headers: { 'content-type': 'application/json' },
      }),
  };
}
