// =============================================================================
// @hopdrive/eventkit — root entry
// =============================================================================
// The root re-exports the core runtime surface: `createEventKit`, `job`, `run`,
// and every public contract type. Sources, plugins, and platform adapters are
// deliberately NOT re-exported here — they are imported from their own subpaths
// (`@hopdrive/eventkit/sources/hasura`, `/plugins/batchjobs`, …) so a function
// only bundles the capabilities it actually uses (§17).

export * from './core/index.js';
