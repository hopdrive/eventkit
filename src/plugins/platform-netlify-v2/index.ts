// =============================================================================
// eventkit — netlifyV2Platform
// =============================================================================
// Modern Netlify v2 `(Request, Context)` → Web `Response`; bucket B (computed
// deadline) unless a v2 context is confirmed to expose a live countdown (D21).
// A platform plugin (`provides: ['platform']`, §11.0/§9.8). Imported via
// `eventkit/platforms`.
import type { HandlerShortCircuit, InvocationResult, PlatformAdapter, RequestContext } from '../../core/index.js';
import { computedDeadline, env, extractHeaders, httpResponse, queryOf } from '../platform-shared.js';

export function netlifyV2Platform(config: { maxExecutionMs?: number } = {}): PlatformAdapter {
  const maxExecutionMs = config.maxExecutionMs ?? 10_000;
  return {
    name: 'platform-netlify-v2',
    provides: ['platform', 'platform:netlify-v2'],
    detect: () => !!env()['NETLIFY'],
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
    formatResponse: (result: InvocationResult) => {
      const { statusCode, body } = httpResponse(result);
      return new Response(body, { status: statusCode, headers: { 'content-type': 'application/json' } });
    },
    // v2 needs a Web Response — a hand-shaped { statusCode } would be a malformed reply.
    formatRejection: (r: HandlerShortCircuit) => new Response(r.body ?? '', { status: r.status, headers: r.headers ?? {} }),
  };
}
