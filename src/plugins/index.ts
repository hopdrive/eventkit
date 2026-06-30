// =============================================================================
// @hopdrive/eventkit/plugins
// =============================================================================
// Aggregate barrel for ALL observer/transform plugins — import the whole family
// from one path: `import { observability, graphqlSink, batchJobs, loopPrevention,
// grafanaLogger, sentry } from '@hopdrive/eventkit/plugins'`. Tree-shakeable (the
// package is sideEffects-free), so naming only the plugins you register doesn't
// bundle the rest. For the tightest bundle you can still import the granular
// subpath (`@hopdrive/eventkit/plugins/observability`, etc.).
//
// (Sources and platforms have their own family barrels: `@hopdrive/eventkit/sources`
// and `@hopdrive/eventkit/platforms`.)
export * from './observability/index.js';
export * from './observability/graphql-sink.js';
export * from './batchjobs/index.js';
export * from './loop-prevention/index.js';
export * from './grafana/index.js';
export * from './sentry/index.js';
