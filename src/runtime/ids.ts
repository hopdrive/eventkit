// Id generation for the runtime.
//
// Uses the platform's built-in `crypto.randomUUID()` (Node ≥20 per engines; also present
// in browsers/workers) instead of the `uuid` package. The dependency was dropped after it
// broke CJS consumers: uuid v14 is ESM-only, so eventkit's CJS build carried a nested copy
// that `require()` refuses at runtime (ERR_REQUIRE_ESM — surfaced by the event-handlers
// migration under netlify dev) and that Jest cannot parse without a moduleNameMapper.
import { asInvocationId, asCorrelationId, type InvocationId, type CorrelationId } from '../core/index.js';

export const newUuid = (): string => globalThis.crypto.randomUUID();
export const newInvocationId = (): InvocationId => asInvocationId(newUuid());
export const newCorrelationId = (): CorrelationId => asCorrelationId(newUuid());
