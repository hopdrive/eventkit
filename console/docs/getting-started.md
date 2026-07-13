# Set up your own EventKit Console

This walks you from nothing to a running console against your own data. The
console is a read-only lens over three tables that eventkit's observability
plugin writes. So there are two halves: get data into the tables (the producer),
and stand up the UI that reads them (the console). This guide covers both.

If you just want the wrapper mechanics and already have the data layer, skip to
[step 5](#5-scaffold-the-console-wrapper) and see [`../template/README.md`](../template/README.md).

## How the pieces fit

```
your event handlers                 Postgres                Hasura            the console
┌───────────────────┐   writes   ┌──────────────┐  source ┌──────────┐  gql  ┌──────────────┐
│ eventkit runtime  │──────────▶ │ invocations  │────────▶│ tracked  │◀──────│ EventKitConsole│
│ + observability   │  graphql   │ event_execs  │         │ tables + │       │ (your wrapper) │
│   plugin (sink)   │            │ job_execs    │         │ rels +   │       └──────────────┘
└───────────────────┘            └──────────────┘         │ ro role  │
                                                          └──────────┘
```

The console never touches Postgres directly. It talks GraphQL to Hasura, which
fronts the observability database. The same three tables serve both eventkit and
the legacy hasura-event-detector, so one console works across a migration.

## Prerequisites

- A Postgres database you can run DDL against (13+; the schema uses
  `gen_random_uuid()` as a fallback).
- A Hasura instance (Cloud or self-hosted) that can reach that database.
- An eventkit app writing observability records (or plans to). See the root
  [README](../../README.md) for the runtime.
- Node 18+ to build and host the wrapper.

## 1. Provision the observability database

Create the database, then apply the schema. The schema script guards on the
database name `event_detector_observability`, so create it with that name (or
edit the guard block at the top of `schema.sql`).

```bash
createdb event_detector_observability

# from the eventkit repo (console/db/schema.sql)
psql -h <host> -U <admin> -d event_detector_observability -f console/db/schema.sql
```

This creates `invocations`, `event_executions`, `job_executions`, plus
`metrics_hourly`, the `dashboard_stats` materialized view, indexes (including
`pg_trgm` GIN indexes for the console's infix search), and `updated_at` triggers.
The `source_event_payload` column is `NOT NULL`; the sink always sends it.

`console/db/schema.sql` is the source of truth for the schema. The
`console/db/local-setup.mjs` and `db/seed/` scripts are HopDrive's local wiring
(they assume a specific Postgres container and seed fake data); you don't need
them for your own setup.

## 2. Add the database as a Hasura source and track the tables

In the Hasura console (Data tab), connect the observability database as a source.
The console queries the source by whatever name you give it through a single
GraphQL endpoint, so the source name doesn't matter to the console; the table
and relationship names below do.

Track these tables/views: `invocations`, `event_executions`, `job_executions`,
`dashboard_stats`, `metrics_hourly`.

## 3. Define the relationships

This is the step most likely to bite you: the console's flow view queries
relationships **by exact name**. If the names differ, the flow page renders
nothing. Postgres has the foreign keys already (from `schema.sql`), so Hasura can
suggest most of these, but two are custom-named and one is a manual self-join
that has no foreign key.

Here is the exact set. You can add them by clicking through Hasura's Data tab, or
paste this into the source's metadata (`metadata/databases/<source>/tables/*.yaml`)
and run `hasura metadata apply`.

**`invocations`**

```yaml
- table:
    name: invocations
    schema: public
  object_relationships:
    # invocations.source_job_id -> job_executions.id (custom name)
    - name: source_job_execution
      using:
        foreign_key_constraint_on: source_job_id
  array_relationships:
    # event_executions.invocation_id -> invocations.id (FK reverse)
    - name: event_executions
      using:
        foreign_key_constraint_on:
          column: invocation_id
          table: { name: event_executions, schema: public }
    # self-join on correlation_id — NO foreign key, so it is a MANUAL relationship
    - name: correlated_invocations
      using:
        manual_configuration:
          remote_table: { name: invocations, schema: public }
          column_mapping:
            correlation_id: correlation_id
```

**`event_executions`**

```yaml
- table:
    name: event_executions
    schema: public
  object_relationships:
    - name: invocation
      using:
        foreign_key_constraint_on: invocation_id
  array_relationships:
    - name: job_executions
      using:
        foreign_key_constraint_on:
          column: event_execution_id
          table: { name: job_executions, schema: public }
```

**`job_executions`**

```yaml
- table:
    name: job_executions
    schema: public
  object_relationships:
    - name: invocation
      using:
        foreign_key_constraint_on: invocation_id
  array_relationships:
    # invocations.source_job_id -> job_executions.id, read from the job side (custom name)
    - name: triggered_invocations
      using:
        foreign_key_constraint_on:
          column: source_job_id
          table: { name: invocations, schema: public }
```

The names that must match exactly: `source_job_execution`, `event_executions`,
`correlated_invocations`, `invocation`, `job_executions`, `triggered_invocations`.
`correlated_invocations` returns every invocation sharing a `correlation_id`
(including the row itself); the console dedupes by id when it builds the graph.

## 4. Create a read-only role for the deployed console

Do not point a deployed console at an admin secret. Anything the browser bundle
holds is readable by anyone who opens dev tools. Create a select-only role and
give the console a JWT that carries it.

Add a `observability_viewer` select permission to each tracked table/view. In
metadata form, per table:

```yaml
  select_permissions:
    - role: observability_viewer
      permission:
        columns: '*'
        filter: {}              # all rows; narrow it if you multi-tenant
        allow_aggregations: true # the Overview/Analytics pages use count aggregates
```

Apply it to `invocations`, `event_executions`, `job_executions`,
`dashboard_stats`, and `metrics_hourly`. No insert/update/delete permissions —
the console never writes.

Then run Hasura in JWT mode (`HASURA_GRAPHQL_JWT_SECRET`) and have your login
issue tokens whose Hasura claims include `observability_viewer` in
`x-hasura-allowed-roles` and as the default role. The wrapper sends that token
(see step 6). Hasura's JWT docs cover the claim shape; nothing here is
console-specific.

For a quick internal-only deploy you can instead put the whole site behind
your host's access control (Netlify/Cloudflare Access, a VPN) and use a scoped
token, but the read-only role is the durable answer.

## 5. Scaffold the console wrapper

The console ships as a component from `hopdrive-eventkit`. You run it inside a
tiny wrapper you own, which passes it config. Scaffold one:

```bash
npx degit hopdrive/eventkit/console/template my-eventkit-console
cd my-eventkit-console
npm install
cp .env.example .env      # set VITE_GRAPHQL_ENDPOINT
npm run dev               # http://localhost:3000
```

The only file you customize is `src/main.tsx`:

```tsx
import { EventKitConsole } from 'hopdrive-eventkit/console';
import 'hopdrive-eventkit/console/style.css';

<EventKitConsole
  config={{
    graphqlEndpoint: import.meta.env.VITE_GRAPHQL_ENDPOINT,
    // production auth (see step 4): your login owns getting the token; the
    // console just puts it on each request. Resolved per request, so a rotating
    // JWT stays fresh without remounting.
    auth: {
      getHeaders: async () => ({ Authorization: `Bearer ${await getToken()}` }),
      onUnauthenticated: () => redirectToLogin(),
    },
  }}
/>;
```

Config options (full list in [`../template/README.md`](../template/README.md)):

| Option | What it does |
|--------|--------------|
| `graphqlEndpoint` | Hasura endpoint for the observability source (required). |
| `headers` | Static per-request headers. Fine for a local `x-hasura-admin-secret`; never for a deployed build. |
| `auth` | Injected auth strategy. `{ getHeaders }` resolves per-request auth headers (a JWT), merged over `headers`; optional `onUnauthenticated` fires on an expired/invalid token. The wrapper owns login. |
| `basename` | Mount under a sub-path (default `/`). |
| `grafanaProxyPath` | Log-viewer fetch prefix (default `/api/grafana`); set `null` to hide logs. |

For local development you can skip the JWT and set `VITE_HASURA_ADMIN_SECRET` in
`.env`; the template reads it into `headers`. Keep that out of any deployed build.

## 6. Deploy

The build is a static SPA (`dist/`) plus one optional function (the Grafana log
proxy). Deploy it anywhere: serve `dist/`, route `/api/grafana/*` to the proxy,
and SPA-fallback everything else to `index.html`. The template ships a
`netlify.toml` that does exactly this; Vercel/Cloudflare/a container are the same
three rules. Set your env in the host (never commit it):

- `VITE_GRAPHQL_ENDPOINT` (client) points at Hasura.
- `GRAFANA_HOST` / `GRAFANA_ID` / `GRAFANA_SECRET` (server-side only, no `VITE_`
  prefix) if you use the log viewer.

## 7. Point eventkit at the database (the producer half)

The console shows nothing until something writes the three tables. In your
eventkit app, register the observability plugin with the built-in GraphQL sink
pointed at the same Hasura source:

```ts
import { createEventKit } from 'hopdrive-eventkit';
import { observability, graphqlSink } from 'hopdrive-eventkit/plugins/observability';

const kit = createEventKit(source)
  .use(observability, {
    sink: graphqlSink({
      endpoint: process.env.OBS_GRAPHQL_ENDPOINT,        // the observability source's Hasura endpoint
      headers: { 'x-hasura-admin-secret': process.env.OBS_ADMIN_SECRET }, // WRITER creds — server-side only
      // mapStatuses defaults to true: eventkit's richer statuses are mapped down
      // to the schema's CHECK sets so writes stay valid. Leave it on for this schema.
    }),
    flushIntervalMs: 2000, // optional: periodic flush so long invocations show up live
  })
  .registerEvents([/* your events */]);
```

The writer uses an admin secret (or a role with insert on the three tables); it
runs server-side in your handler, so that secret never reaches a browser. This is
a separate credential from the read-only one the console uses.

Run a real event (or replay one), then open the console. The Overview and
Invocations pages should populate; click an invocation into the Flow page to see
the chain.

## Troubleshooting

- **Flow page is blank but Invocations has rows.** A relationship name is wrong
  or missing. Re-check step 3, especially the custom names `source_job_execution`
  and `triggered_invocations` and the manual `correlated_invocations`.
- **Overview/Analytics error on aggregates.** The role is missing
  `allow_aggregations: true` (step 4).
- **A column shows up in Postgres but not in GraphQL.** Reload the source's
  metadata in Hasura after schema changes (`reload_metadata` with source reload;
  the plain reload button is not always enough).
- **Everything is empty.** Nothing is writing yet. Confirm step 7 is wired and an
  event actually ran; check your handler logs for `observability sink flush failed`.
- **Logs tab says "not configured".** The Grafana proxy needs
  `GRAFANA_HOST`/`GRAFANA_ID`/`GRAFANA_SECRET` on the host, or set
  `grafanaProxyPath: null` to hide the tab.

## Reference

- Wrapper details and config: [`../template/README.md`](../template/README.md)
- Design and decisions: [`../../docs/planning/console-migration-plan.md`](../../docs/planning/console-migration-plan.md) (§14 for the export model)
- Schema: [`../db/schema.sql`](../db/schema.sql)
