// =============================================================================
// eventkit — root entry
// =============================================================================
// The root re-exports the core contract types + pure utilities (from ./core) and
// the runtime constructor `createEventKit` (from ./runtime). Per ADR-025 the job
// executor is runtime-internal — there is no public `run()`; modules declare a
// static `jobs` array and the runtime runs it. Sources, plugins, and platform
// adapters are deliberately NOT re-exported here — they are imported from their own
// subpaths (`eventkit/sources/hasura`, `/plugins/batch`, …) so a
// function only bundles what it uses (§17).

export * from './core/index.js';
export { createEventKit } from './runtime/index.js';
