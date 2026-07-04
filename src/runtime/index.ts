// =============================================================================
// eventkit runtime
// =============================================================================
// The runtime layer: createEventKit(). Depends on core (types + pure utilities) but
// core never depends back on it. The root package re-exports createEventKit. The job
// executor (./run.js) is runtime-internal (ADR-025) and is NOT exported.

export { createEventKit } from './kit.js';
