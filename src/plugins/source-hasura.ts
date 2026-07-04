// =============================================================================
// eventkit/sources/hasura
// =============================================================================
// Barrel for the Hasura source family — the short public entry point so consumers
// keep `import { hasuraEvent } from 'eventkit/sources/hasura'`. Each
// adapter is its own flat plugin folder (ADR-027): `source-hasura-event`,
// `source-hasura-cron`, `source-hasura-action`; shared parsing/types live in
// `hasura-shared`.
export type * from './hasura-shared/types.js';
export {
  columnChanged,
  columnAdded,
  columnRemoved,
  getOperation,
  getOldRow,
  getNewRow,
  getSession,
} from './hasura-shared/payload.js';
export { hasuraEvent, type HasuraEventSource, type HasuraEventConfig } from './source-hasura-event/index.js';
export { hasuraCron, type HasuraCronSource, type HasuraCronConfig } from './source-hasura-cron/index.js';
export { hasuraAction, type HasuraActionSource, type HasuraActionConfig } from './source-hasura-action/index.js';
export { collectTokenCandidates, type HasuraTokenDiscoveryConfig } from './hasura-shared/token-discovery.js';
export {
  hasuraChainedClient,
  GraphqlRequestError,
  type HasuraChainedClientConfig,
  type GqlFunction,
} from './hasura-shared/chained-client.js';
