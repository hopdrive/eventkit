// =============================================================================
// eventkit/plugins
// =============================================================================
// Aggregate barrel for ALL observer/transform plugins — import the whole family
// from one path: `import { observability, graphqlSink, batch, loopGuard,
// grafana, sentry } from 'eventkit/plugins'`. Tree-shakeable (the
// package is sideEffects-free), so naming only the plugins you register doesn't
// bundle the rest. For the tightest bundle you can still import the granular
// subpath (`eventkit/plugins/observability`, etc.).
//
// (Sources and platforms have their own family barrels: `eventkit/sources`
// and `eventkit/platforms`.)
export * from './observability/index.js';
export * from './observability/graphql-sink.js';
export * from './batch/index.js';
export * from './loop-guard/index.js';
export * from './correlation-resolver/index.js';
export * from './grafana/index.js';
export * from './sentry/index.js';
