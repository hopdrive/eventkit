/**
 * Shared helper: extract local postgres + Hasura admin credentials at
 * runtime by parsing hasura-migrations/docker-compose.yml. Used by both
 * db/local-setup.mjs and db/seed/seed.mjs so neither script (nor this
 * repo) ever hard-codes or commits a local secret.
 *
 * This is a minimal, targeted extraction — not a general YAML parser. It
 * pulls specific `KEY: value` lines out of the compose file's
 * `environment:` blocks. Good enough for this one well-known file; do not
 * reuse it as a general-purpose compose/YAML parser elsewhere.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const DB_NAME = 'event_detector_observability';
export const POSTGRES_CONTAINER = process.env.POSTGRES_CONTAINER || 'hopdrive-postgres';
export const METADATA_URL = process.env.HASURA_METADATA_URL || 'https://gql.local.hopdrive.io/v1/metadata';
export const GRAPHQL_URL = process.env.HASURA_GRAPHQL_URL || 'https://gql.local.hopdrive.io/v1/graphql';

/** Find hasura-migrations/docker-compose.yml by checking common sibling-checkout layouts. */
export function findDockerComposePath(fromDir) {
  if (process.env.HASURA_MIGRATIONS_DIR) {
    const p = path.join(process.env.HASURA_MIGRATIONS_DIR, 'docker-compose.yml');
    if (existsSync(p)) return p;
    throw new Error(`HASURA_MIGRATIONS_DIR set but ${p} does not exist`);
  }
  const candidates = [
    path.join(fromDir, '../../../../hasura-migrations/docker-compose.yml'), // eventkit sibling checkout, from db/ or db/seed/
    path.join(fromDir, '../../../hasura-migrations/docker-compose.yml'),
    path.join(process.env.HOME || '', 'Github/hasura-migrations/docker-compose.yml'),
    path.join(process.env.HOME || '', 'github/hasura-migrations/docker-compose.yml'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `Could not find hasura-migrations/docker-compose.yml. Checked: ${candidates.join(', ')}. ` +
      `Set HASURA_MIGRATIONS_DIR to override.`
  );
}

export function extractComposeCredentials(composePath) {
  const content = readFileSync(composePath, 'utf8');

  const pgPasswordMatch = content.match(/POSTGRES_PASSWORD:\s*"?([^"\s#]+)"?/);
  const pgUserMatch = content.match(/POSTGRES_USER:\s*"?([^"\s#]+)"?/);
  const adminSecretMatch = content.match(/HASURA_GRAPHQL_ADMIN_SECRET:\s*"?([^"\s#]+)"?/);

  if (!pgPasswordMatch) {
    throw new Error(`Could not find POSTGRES_PASSWORD in ${composePath}`);
  }
  if (!adminSecretMatch) {
    throw new Error(`Could not find HASURA_GRAPHQL_ADMIN_SECRET in ${composePath}`);
  }

  return {
    pgUser: pgUserMatch ? pgUserMatch[1] : 'postgres', // postgis/postgis default superuser
    pgPassword: pgPasswordMatch[1],
    adminSecret: adminSecretMatch[1],
  };
}

/** Convenience: locate the compose file relative to `fromDir` and extract credentials in one call. */
export function getLocalCredentials(fromDir) {
  const composePath = findDockerComposePath(fromDir);
  return { composePath, ...extractComposeCredentials(composePath) };
}
