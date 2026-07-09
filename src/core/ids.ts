// =============================================================================
// Internal id generation (not part of the public core surface)
// =============================================================================
// One home for the "crypto.randomUUID with a degraded fallback" expression that
// was previously copy-pasted across the source adapters, observability, and the
// testing helpers. The fallback only fires in environments without
// `crypto.randomUUID` (older non-secure-context browsers — every supported Node
// version has it); the prefix keeps a degraded id traceable to its origin and a
// monotonic counter keeps same-millisecond ids unique.
//
// The runtime's strict, fallback-free variants live in `../runtime/ids.ts`.

let counter = 0;

/** A UUID where available, else a `<prefix>-<time36>-<n>` degraded id. */
export const randomId = (prefix: string): string =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
