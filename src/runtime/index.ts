// =============================================================================
// @hopdrive/eventkit runtime
// =============================================================================
// The executor layer: createEventKit() and run(). Depends on core (types +
// pure utilities) but core never depends back on it. The root package re-exports
// these two so consumers import them from '@hopdrive/eventkit'.

export { createEventKit } from './kit.js';
export { run } from './run.js';
