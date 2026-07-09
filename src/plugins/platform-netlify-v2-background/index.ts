// =============================================================================
// eventkit — netlifyV2BackgroundPlatform
// =============================================================================
// Netlify Functions 2.0 BACKGROUND functions: the modern `(Request, Context)` →
// Web `Response` shape (like netlifyV2Platform), but for a function declared
// `export const config = { background: true }`. Netlify auto-returns 202 and runs
// the function for up to ~15 min, ignoring the returned body — so this is bucket A
// with a long budget and `deferredResponse: true` (a result-driven `respond` can't
// observe a reply that's already been sent; the Kit.validate guard enforces this).
// It reuses netlifyV2Platform's Web-Request plumbing (extractPayload/buildRequest/
// formatRejection) and only diverges on the deferred budget + 202 response.
// A platform plugin (`provides: ['platform']`, §11.0/§9.8, ADR-027). Imported via
// `eventkit/platforms`.
import type { PlatformAdapter, RequestContext } from '../../core/index.js';
import { computedDeadline, env, extractV2Payload, v2Meta, webRejection } from '../platform-shared.js';

export function netlifyV2BackgroundPlatform(config: { maxExecutionMs?: number } = {}): PlatformAdapter {
  const maxExecutionMs = config.maxExecutionMs ?? 15 * 60 * 1000;
  return {
    name: 'platform-netlify-v2-background',
    provides: ['platform', 'platform:netlify-v2-background'],
    detect: () => !!env()['NETLIFY'],
    // Netlify answers 202 before jobs finish → a result-driven `respond` can't apply here.
    deferredResponse: true,
    // Read the Web Request body once: parsed JSON as the payload, exact bytes cached for rawBody.
    extractPayload: (request: unknown) => extractV2Payload(request),
    buildRequest: (request?: unknown): RequestContext => ({
      getRemainingTimeMs: computedDeadline(maxExecutionMs),
      // headers + query + rawBody (the exact bytes extractPayload cached) — HMAC verify needs rawBody.
      meta: v2Meta(request),
    }),
    // Netlify ignores the body for a background function, but `netlify dev` and any
    // non-background invocation still need a valid Web Response (not a { statusCode }).
    formatResponse: () => new Response(null, { status: 202 }),
    formatRejection: webRejection,
  };
}
