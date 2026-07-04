// =============================================================================
// eventkit — lambdaPlatform
// =============================================================================
// Raw AWS Lambda `(event, context)`; bucket A (native countdown). A platform
// plugin (`provides: ['platform']`, §11.0/§9.8). Imported via `eventkit/platforms`.
import type { InvocationResult, PlatformAdapter, RequestContext } from '../../core/index.js';
import { env, extractHttpBody, httpRejection, httpResponse, nativeCountdown, requestMeta, type LambdaContext } from '../platform-shared.js';

export function lambdaPlatform(): PlatformAdapter {
  return {
    name: 'platform-lambda',
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
