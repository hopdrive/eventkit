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
import type { HandlerShortCircuit, PlatformAdapter, RequestContext } from '../../core/index.js';
import { computedDeadline, env, extractHeaders, queryOf } from '../platform-shared.js';

export function netlifyV2BackgroundPlatform(config: { maxExecutionMs?: number } = {}): PlatformAdapter {
  const maxExecutionMs = config.maxExecutionMs ?? 15 * 60 * 1000;
  return {
    name: 'platform-netlify-v2-background',
    provides: ['platform', 'platform:netlify-v2-background'],
    detect: () => !!env()['NETLIFY'],
    // Netlify answers 202 before jobs finish → a result-driven `respond` can't apply here.
    deferredResponse: true,
    extractPayload: async (request: unknown) => {
      const req = request as { json?: () => Promise<unknown> } | undefined;
      if (req && typeof req.json === 'function') return req.json();
      return req;
    },
    buildRequest: (request?: unknown): RequestContext => ({
      getRemainingTimeMs: computedDeadline(maxExecutionMs),
      // v2 can't preserve rawBody (extractPayload consumed it via .json()); headers + query are fine.
      meta: { headers: extractHeaders(request), query: queryOf(request) },
    }),
    // Netlify ignores the body for a background function, but `netlify dev` and any
    // non-background invocation still need a valid Web Response (not a { statusCode }).
    formatResponse: () => new Response(null, { status: 202 }),
    // v2 needs a Web Response — a hand-shaped { statusCode } would be a malformed reply.
    formatRejection: (r: HandlerShortCircuit) => new Response(r.body ?? '', { status: r.status, headers: r.headers ?? {} }),
  };
}
