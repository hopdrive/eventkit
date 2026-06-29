// =============================================================================
// @hopdrive/eventkit — root entry
// =============================================================================
// The root re-exports the core contract types + pure utilities (from ./core) and
// the runtime executors `createEventKit` and `run` (from ./runtime). Sources,
// plugins, and platform adapters are deliberately NOT re-exported here — they are
// imported from their own subpaths (`@hopdrive/eventkit/sources/hasura`,
// `/plugins/batchjobs`, …) so a function only bundles what it uses (§17).

export * from './core/index.js';
export { createEventKit, run } from './runtime/index.js';
