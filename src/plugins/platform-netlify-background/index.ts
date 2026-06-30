// =============================================================================
// @hopdrive/eventkit — netlifyBackgroundPlatform
// =============================================================================
// Netlify Background Functions: ~15-min budget, returns 202 immediately (the return
// body is ignored by the platform). Bucket A with a long budget; powers the live
// batch_jobs watch view (§12.6). A platform plugin (`provides: ['platform']`,
// §11.0/§9.8). Imported via `@hopdrive/eventkit/platforms`.
import type { PlatformAdapter, RequestContext } from '../../core/index.js';
import { computedDeadline, env, extractHttpBody, httpRejection, nativeCountdown, type LambdaContext } from '../platform-shared.js';

export function netlifyBackgroundPlatform(config: { maxExecutionMs?: number } = {}): PlatformAdapter {
  const maxExecutionMs = config.maxExecutionMs ?? 15 * 60 * 1000;
  return {
    name: 'platform-netlify-background',
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
