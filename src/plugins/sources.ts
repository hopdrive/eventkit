// =============================================================================
// eventkit/sources
// =============================================================================
// Aggregate barrel for ALL source plugins — import the whole family from one
// path: `import { hasuraEvent, hasuraCron, hasuraAction, webhook } from
// 'eventkit/sources'`. Tree-shakeable (the package is sideEffects-free),
// so a function that names only `hasuraEvent` doesn't bundle the others. For the
// tightest possible bundle you can still import the granular subpath
// (`eventkit/sources/hasura`, `/sources/webhook`).
export * from './source-hasura.js';
export * from './source-webhook/index.js';
