// =============================================================================
// @hopdrive/eventkit/platforms
// =============================================================================
// Platform adapters (§9.8, ADR-021). Optional capability providers registered
// via `kit.use(netlifyPlatform)`. They are the only place that touches platform
// specifics: invocation signature, payload extraction, time budget, response
// shape. Phase 4 implements them.
//
// Time-budget strategy collapses to three buckets, all surfaced as
// `RequestContext.getRemainingTimeMs`:
//   A — native countdown (Lambda, Netlify classic)
//   B — computed deadline from a configured max (Vercel, Netlify v2)
//   C — none (long-running servers, local/test)

import type { PlatformAdapter } from '../core/index.js';
import { NotImplementedError } from '../core/index.js';

const notImpl = (what: string): never => {
  throw new NotImplementedError(`${what} — platform adapters land in Phase 4.`);
};

/** Raw AWS Lambda `(event, context)`; bucket A. */
export function lambdaPlatform(): PlatformAdapter {
  return notImpl('lambdaPlatform()');
}

/** Netlify classic Functions `(event, context)`; Lambda-backed; bucket A. */
export function netlifyPlatform(): PlatformAdapter {
  return notImpl('netlifyPlatform()');
}

/** Netlify v2 `(Request, Context)` → `Response`; bucket B (D21 — verify at impl). */
export function netlifyV2Platform(): PlatformAdapter {
  return notImpl('netlifyV2Platform()');
}

/** Netlify Background Functions; ~15-min budget, returns 202; powers the live batch_jobs view. */
export function netlifyBackgroundPlatform(): PlatformAdapter {
  return notImpl('netlifyBackgroundPlatform()');
}
