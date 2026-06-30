// =============================================================================
// @hopdrive/eventkit/sources/hasura
// =============================================================================
// Barrel for the Hasura source family — the short public entry point so consumers
// keep `import { hasuraEvent } from '@hopdrive/eventkit/sources/hasura'`. Each
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
export { hasuraEvent, type HasuraEventSource } from './source-hasura-event/index.js';
export { hasuraCron, type HasuraCronSource } from './source-hasura-cron/index.js';
export { hasuraAction, type HasuraActionSource } from './source-hasura-action/index.js';
