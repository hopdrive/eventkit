#!/usr/bin/env node
/**
 * EventKit Console — local DB & Hasura wiring (Phase C1, one-time / idempotent)
 *
 * Zero-dependency Node script. Never hard-codes credentials: postgres
 * user/password and the local Hasura admin secret are extracted at runtime
 * by parsing hasura-migrations/docker-compose.yml (the file most engineers
 * already have checked out locally). See
 * docs/planning/console-migration-plan.md §8 in the eventkit repo.
 *
 * What it does:
 *   1. Locates hasura-migrations/docker-compose.yml and extracts:
 *        - the postgres service's POSTGRES_PASSWORD (user defaults to
 *          'postgres' unless POSTGRES_USER is set — the postgis/postgis
 *          image's default superuser)
 *        - the graphql-engine service's HASURA_GRAPHQL_ADMIN_SECRET
 *   2. Creates the `event_detector_observability` database in the
 *      `hopdrive-postgres` container if it doesn't already exist.
 *   3. Applies db/schema.sql if the `invocations` table isn't already
 *      present (idempotent — safe to re-run).
 *   4. Calls the Hasura metadata API (pg_update_source) to point the
 *      existing (currently-inconsistent) `events` source at a literal
 *      connection string reachable from inside the docker network
 *      (postgres://<user>:<pass>@hopdrive-postgres:5432/event_detector_observability),
 *      then reload_metadata.
 *   5. Verifies with a GraphQL query that invocations_aggregate resolves.
 *
 * Usage:
 *   node db/local-setup.mjs
 *
 * Env overrides (optional):
 *   HASURA_MIGRATIONS_DIR   path to the hasura-migrations checkout
 *                           (default: ../../hasura-migrations relative to
 *                           common sibling-checkout layouts, see below)
 *   HASURA_METADATA_URL     default https://gql.local.hopdrive.io/v1/metadata
 *   HASURA_GRAPHQL_URL      default https://gql.local.hopdrive.io/v1/graphql
 *   POSTGRES_CONTAINER      default hopdrive-postgres
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Local Hasura endpoints (gql.local.hopdrive.io) serve a mkcert-issued
// cert. macOS curl trusts it via the System keychain, but Node's fetch
// (undici) doesn't consult the OS keychain, so plain `fetch()` fails with
// UNABLE_TO_VERIFY_LEAF_SIGNATURE. NODE_EXTRA_CA_CERTS is only honored if
// set *before* the process starts (setting process.env at runtime is too
// late), so if it's missing and mkcert is available, re-exec ourselves once
// with it set rather than disabling TLS verification.
if (!process.env.NODE_EXTRA_CA_CERTS && !process.env.__LOCAL_SETUP_REEXEC) {
  try {
    const caRoot = execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8' }).trim();
    const rootCaPath = path.join(caRoot, 'rootCA.pem');
    if (existsSync(rootCaPath)) {
      const result = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: { ...process.env, NODE_EXTRA_CA_CERTS: rootCaPath, __LOCAL_SETUP_REEXEC: '1' },
      });
      process.exit(result.status ?? 1);
    }
  } catch {
    // mkcert not installed / not on PATH — continue without it; the
    // metadata/graphql fetch calls below will surface a clear TLS error.
  }
}
const DB_NAME = 'event_detector_observability';
const POSTGRES_CONTAINER = process.env.POSTGRES_CONTAINER || 'hopdrive-postgres';
const METADATA_URL = process.env.HASURA_METADATA_URL || 'https://gql.local.hopdrive.io/v1/metadata';
const GRAPHQL_URL = process.env.HASURA_GRAPHQL_URL || 'https://gql.local.hopdrive.io/v1/graphql';
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

function log(...args) {
  console.log('[local-setup]', ...args);
}

/** Find hasura-migrations/docker-compose.yml by checking common sibling-checkout layouts. */
function findDockerComposePath() {
  if (process.env.HASURA_MIGRATIONS_DIR) {
    const p = path.join(process.env.HASURA_MIGRATIONS_DIR, 'docker-compose.yml');
    if (existsSync(p)) return p;
    throw new Error(`HASURA_MIGRATIONS_DIR set but ${p} does not exist`);
  }
  const candidates = [
    path.join(__dirname, '../../../hasura-migrations/docker-compose.yml'), // eventkit sibling checkout
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

/**
 * Minimal, targeted extraction — not a general YAML parser. Pulls specific
 * `KEY: value` lines out of the compose file's `environment:` blocks. Good
 * enough for this one well-known file; do not reuse elsewhere.
 */
function extractComposeCredentials(composePath) {
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

function psql(pgUser, args, { input } = {}) {
  return execFileSync(
    'docker',
    ['exec', ...(input ? ['-i'] : []), POSTGRES_CONTAINER, 'psql', '-U', pgUser, ...args],
    { encoding: 'utf8', input }
  );
}

function databaseExists(pgUser) {
  const out = psql(pgUser, ['-tAc', `SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'`]);
  return out.trim() === '1';
}

function tableExists(pgUser) {
  const out = psql(pgUser, [
    '-d',
    DB_NAME,
    '-tAc',
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='invocations'`,
  ]);
  return out.trim() === '1';
}

async function metadataApi(adminSecret, body) {
  const res = await fetch(METADATA_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hasura-admin-secret': adminSecret,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Metadata API ${body.type} failed (${res.status}): ${text}`);
  }
  return json;
}

async function graphqlQuery(adminSecret, query, variables) {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hasura-admin-secret': adminSecret,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL query failed: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function main() {
  const composePath = findDockerComposePath();
  log(`Using docker-compose.yml at ${composePath}`);

  const { pgUser, pgPassword, adminSecret } = extractComposeCredentials(composePath);
  log(`Extracted postgres user "${pgUser}" and Hasura admin secret (not printed) from compose file.`);

  // 1. Create database if needed
  if (databaseExists(pgUser)) {
    log(`Database "${DB_NAME}" already exists — skipping creation.`);
  } else {
    log(`Creating database "${DB_NAME}"...`);
    psql(pgUser, ['-c', `CREATE DATABASE ${DB_NAME}`]);
    log('Database created.');
  }

  // 2. Apply schema if needed
  if (tableExists(pgUser)) {
    log('Table "invocations" already present — skipping schema.sql (idempotent, not reapplying DDL).');
  } else {
    if (!existsSync(SCHEMA_PATH)) {
      throw new Error(`schema.sql not found at ${SCHEMA_PATH}`);
    }
    log('Applying db/schema.sql...');
    const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
    psql(pgUser, ['-d', DB_NAME, '-v', 'ON_ERROR_STOP=1', '-f', '/dev/stdin'], { input: schemaSql });
    log('Schema applied.');
  }

  // 3. Point the Hasura `events` source at a literal, docker-network-reachable
  //    connection string (fixes: EVENT_DETECTOR_DATABASE_URL not set on the engine).
  //
  //    Note: `pg_update_source` (the "obvious" API for this) 400s with
  //    "source with name \"events\" does not exist" when the source is
  //    already inconsistent — it validates against the resolved schema
  //    cache, not the raw metadata document, and an inconsistent source
  //    never makes it into that cache. export_metadata + edit +
  //    replace_metadata (with allow_inconsistent_metadata so the *other*,
  //    unrelated inconsistent objects in this shared local Hasura instance
  //    don't block the write) operates on the raw document instead, so it
  //    works regardless of the source's current consistency state.
  const connectionString = `postgres://${pgUser}:${pgPassword}@${POSTGRES_CONTAINER}:5432/${DB_NAME}`;
  log('Exporting current metadata...');
  const metadata = await metadataApi(adminSecret, { type: 'export_metadata', args: {} });
  const eventsSource = metadata.sources?.find(s => s.name === 'events');
  if (!eventsSource) {
    throw new Error('No "events" source found in Hasura metadata — expected it to already exist (hasura-migrations/hasura/metadata/databases/events/).');
  }

  const currentUrl = eventsSource.configuration?.connection_info?.database_url;
  if (currentUrl === connectionString) {
    log('Source "events" already points at the expected literal connection string — skipping update.');
  } else {
    log(`Updating Hasura source "events" to use a literal connection string (host: ${POSTGRES_CONTAINER})...`);
    eventsSource.configuration = {
      connection_info: {
        database_url: connectionString,
        isolation_level: 'read-committed',
        use_prepared_statements: false,
      },
    };
    await metadataApi(adminSecret, {
      type: 'replace_metadata',
      args: { allow_inconsistent_metadata: true, metadata },
    });
    log('Source updated via replace_metadata. Reloading metadata...');
    await metadataApi(adminSecret, { type: 'reload_metadata', args: {} });
    log('Metadata reloaded.');
  }

  const inconsistent = await metadataApi(adminSecret, { type: 'get_inconsistent_metadata', args: {} });
  const eventsStillInconsistent = (inconsistent.inconsistent_objects || []).some(
    o => JSON.stringify(o.definition).includes('events') && o.name === 'source events'
  );
  if (eventsStillInconsistent) {
    throw new Error(`Source "events" is still inconsistent after update: ${JSON.stringify(inconsistent.inconsistent_objects)}`);
  }
  log('Source "events" is consistent. (Other, unrelated sources/tables in this shared local Hasura instance may still be inconsistent — not our concern here.)');

  // 4. Verify
  log('Verifying with a GraphQL query (invocations_aggregate)...');
  const data = await graphqlQuery(adminSecret, `query { invocations_aggregate { aggregate { count } } }`);
  const count = data?.invocations_aggregate?.aggregate?.count;
  if (typeof count !== 'number') {
    throw new Error(`Verification query did not return a count: ${JSON.stringify(data)}`);
  }
  log(`Verification OK — invocations_aggregate.aggregate.count = ${count}`);
  log('Local DB + Hasura source wiring complete.');
}

main().catch(err => {
  console.error('[local-setup] FAILED:', err.message);
  process.exit(1);
});
