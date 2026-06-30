// =============================================================================
// @hopdrive/eventkit — netlifyPlatform (classic)
// =============================================================================
// Netlify classic Functions `(event, context)`; bucket A (Lambda-backed). A platform
// plugin (`provides: ['platform']`, §11.0/§9.8). Imported via `@hopdrive/eventkit/platforms`.
import type { InvocationResult, PlatformAdapter, RequestContext } from '../../core/index.js';
import { env, extractHttpBody, httpRejection, httpResponse, nativeCountdown, requestMeta, type LambdaContext } from '../platform-shared.js';

export function netlifyPlatform(): PlatformAdapter {
  return {
    name: 'platform-netlify',
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
