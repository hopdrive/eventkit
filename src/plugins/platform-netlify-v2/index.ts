// =============================================================================
// eventkit — netlifyV2Platform
// =============================================================================
// Modern Netlify v2 `(Request, Context)` → Web `Response`; bucket B (computed
// deadline) unless a v2 context is confirmed to expose a live countdown (D21).
// A platform plugin (`provides: ['platform']`, §11.0/§9.8). Imported via
// `eventkit/platforms`.
import type { InvocationResult, PlatformAdapter, RequestContext } from '../../core/index.js';
import { computedDeadline, env, extractV2Payload, httpResponse, v2Meta, webRejection } from '../platform-shared.js';

export function netlifyV2Platform(config: { maxExecutionMs?: number } = {}): PlatformAdapter {
  const maxExecutionMs = config.maxExecutionMs ?? 10_000;
  return {
    name: 'platform-netlify-v2',
    provides: ['platform', 'platform:netlify-v2'],
    detect: () => !!env()['NETLIFY'],
    // Read the Web Request body once: parsed JSON as the payload, exact bytes cached for rawBody.
    extractPayload: (request: unknown) => extractV2Payload(request),
    buildRequest: (request?: unknown): RequestContext => ({
      getRemainingTimeMs: computedDeadline(maxExecutionMs),
      // headers + query + rawBody (the exact bytes extractPayload cached) — HMAC verify needs rawBody.
      meta: v2Meta(request),
    }),
    formatResponse: (result: InvocationResult) => {
      const { statusCode, body } = httpResponse(result);
      return new Response(body, { status: statusCode, headers: { 'content-type': 'application/json' } });
    },
    formatRejection: webRejection,
  };
}
