// =============================================================================
// eventkit — netlifyV2Platform
// =============================================================================
// Modern Netlify v2 `(Request, Context)` → Web `Response`; bucket B (computed
// deadline) unless a v2 context is confirmed to expose a live countdown (D21).
// A platform plugin (`provides: ['platform']`, §11.0/§9.8). Imported via
// `eventkit/platforms`.
//
// After-response work (ADR-045): Netlify v2 hands every function a `context` whose
// `waitUntil(promise)` sends the response at once and keeps the invocation alive
// until the promise settles. The adapter surfaces it as `RequestContext.waitUntil`,
// so the runtime writes telemetry (observability, log transports) AFTER the reply
// instead of making the caller wait on it.
import type { InvocationResult, PlatformAdapter, RequestContext } from '../../core/index.js';
import { computedDeadline, env, extractV2Payload, httpResponse, v2Meta, webRejection } from '../platform-shared.js';

/** The slice of Netlify's Functions v2 `Context` this adapter reads. */
export interface NetlifyV2Context {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface NetlifyV2PlatformConfig {
  /** Computed-deadline budget (ms). Default 10000. */
  maxExecutionMs?: number;
  /**
   * Where end-of-invocation work (observability writes, log-transport flushes) runs.
   *   - `'defer'` (default): after the response, under `context.waitUntil`.
   *   - `'await'`: before the response, as eventkit did before 0.8.0.
   * `'defer'` falls back to `'await'` for a request whose context has no `waitUntil`
   * (an old `netlify dev`, or a caller that didn't pass the context), with a one-time warning.
   */
  afterResponse?: 'defer' | 'await';
}

export function netlifyV2Platform(config: NetlifyV2PlatformConfig = {}): PlatformAdapter {
  const maxExecutionMs = config.maxExecutionMs ?? 10_000;
  const defer = config.afterResponse !== 'await';
  let warnedNoWaitUntil = false;

  const waitUntilOf = (context: unknown): RequestContext['waitUntil'] => {
    if (!defer) return undefined;
    const ctx = context as NetlifyV2Context | undefined;
    if (typeof ctx?.waitUntil === 'function') return promise => ctx.waitUntil!(promise);
    if (!warnedNoWaitUntil) {
      warnedNoWaitUntil = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[eventkit] platform-netlify-v2: the request's context has no waitUntil, so end-of-invocation work ` +
          `(observability writes, log flushes) runs before the response. Pass Netlify's context through ` +
          `(export default kit.handler() as-is), or update the Netlify CLI for local dev.`,
      );
    }
    return undefined;
  };

  return {
    name: 'platform-netlify-v2',
    provides: ['platform', 'platform:netlify-v2'],
    detect: () => !!env()['NETLIFY'],
    // Read the Web Request body once: parsed JSON as the payload, exact bytes cached for rawBody.
    extractPayload: (request: unknown) => extractV2Payload(request),
    buildRequest: (request?: unknown, context?: unknown): RequestContext => {
      const req: RequestContext = {
        getRemainingTimeMs: computedDeadline(maxExecutionMs),
        // headers + query + rawBody (the exact bytes extractPayload cached) — HMAC verify needs rawBody.
        meta: v2Meta(request),
      };
      const waitUntil = waitUntilOf(context);
      if (waitUntil) req.waitUntil = waitUntil;
      return req;
    },
    formatResponse: (result: InvocationResult) => {
      const { statusCode, body, headers } = httpResponse(result);
      // Declared ResponseWire headers win over the json default — new Response(body, init) as data.
      return new Response(body, { status: statusCode, headers: { 'content-type': 'application/json', ...(headers ?? {}) } });
    },
    formatRejection: webRejection,
  };
}
