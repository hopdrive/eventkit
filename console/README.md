# EventKit Console

Observability Console UI for EventKit (and legacy Hasura Event Detector — schema-compatible during the runtime migration).

This directory is **both** the development home of the console **and** the source that ships as a mountable component: `hopdrive-eventkit/console`. It is not published as its own npm package — it rides along inside `hopdrive-eventkit` as a subpath export, built by `vite.lib.config.ts` into the root package's `dist/console/`.

## How consumers use it

**Setting one up from scratch?** Follow [`docs/getting-started.md`](docs/getting-started.md) — it walks the whole thing end to end: provision the observability DB, add it as a Hasura source, define the relationships (with copy-pasteable metadata), create the read-only role, point eventkit's writer at it, then scaffold and deploy the wrapper.

The short version: the console is a component. A host wrapper passes it config (endpoint + auth); the wrapper owns hosting. Scaffold the wrapper:

```bash
npx degit hopdrive/eventkit/console/template my-eventkit-console
cd my-eventkit-console && npm install
cp .env.example .env      # set VITE_GRAPHQL_ENDPOINT
npm run dev
```

The one file the wrapper customizes:

```tsx
import { EventKitConsole } from 'hopdrive-eventkit/console';
import 'hopdrive-eventkit/console/style.css';

<EventKitConsole config={{ graphqlEndpoint: import.meta.env.VITE_GRAPHQL_ENDPOINT }} />
```

The console library externalizes `react` and its React-coupled UI libs (react-router-dom, @apollo/client, reactflow, recharts, framer-motion, @heroicons, @microlink/react-json-view, @tanstack/*, antd). The consumer's app build bundles those — where React is not external, so their internal `require("react")` resolves normally (a lib build that externalizes react would emit a throwing `__require("react")` shim; that's why the console does not bundle them). Only `react` + `react-dom` are declared peers (optional). The wrapper template lists the rest as real dependencies. See `template/` and `docs/planning/console-migration-plan.md` §14.

### Config

`<EventKitConsole config={...} />` (`src/config.tsx`):

- `graphqlEndpoint` — Hasura endpoint for the observability DB.
- `headers` — static per-request headers (local `x-hasura-admin-secret` only; never in a deployed build).
- `auth` — injected auth strategy. `{ getHeaders }` resolves per-request auth headers (a rotating JWT); optional `onUnauthenticated` fires when Hasura rejects the token. The wrapper owns login; the console just uses this to authorize Apollo.
- `basename` — mount under a sub-path (default `/`).
- `grafanaProxyPath` — log-viewer fetch prefix (default `/api/grafana`); `null` hides logs.

## Quick Start (develop the console itself)

```bash
# 1. Install dependencies
npm install

# 2. Copy the env template and fill in local values
cp .env.example .env

# 3. Start the dev server (mounts <EventKitConsole> from your local env — see src/index.tsx)
npm run dev

# 4. Open in browser
# Navigate to http://localhost:3000
```

## What is this?

This is the web UI for monitoring the EventKit event pipeline (and, during the migration, the legacy Hasura Event Detector — both write the same `event_detector_observability` tables). It shows:
- Real-time event processing
- Performance metrics
- Error logs
- Event flow visualizations
- Job execution tracking

## Development

```bash
# Install dependencies
npm install

# Start development server (standalone app — src/index.tsx reads local env)
npm run dev

# Build the standalone app (local-dev / self-host path)
npm run build

# Build the library artifact that ships as hopdrive-eventkit/console
# (outputs to the ROOT package's dist/console: index.js, style.css, index.d.ts)
npm run build:lib

# Regenerate GraphQL types from the schema in VITE_GRAPHQL_ENDPOINT
npm run codegen
```

## Configuration

The published **library** takes config as a prop (see "Config" above) — it reads no environment variables, so one built artifact runs anywhere.

The **standalone dev app** (`src/index.tsx`) builds that config object from env — see `.env.example`. There is no `console.config.js`; do not reintroduce one (it previously held a hard-coded admin secret).

- `VITE_GRAPHQL_ENDPOINT` — Hasura GraphQL endpoint
- `VITE_HASURA_ADMIN_SECRET` — **local dev only**; never set this in a deployed environment (see `docs/planning/console-migration-plan.md` §5/S1 for the planned `observability_viewer` role + JWT auth)
- `GRAFANA_HOST`, `GRAFANA_ID`, `GRAFANA_SECRET` — server-side only, consumed by the proxy function (`netlify/functions/grafana-proxy.ts`, over the host-agnostic `grafanaProxyCore.ts`), never exposed to the client bundle

### Grafana Logs Integration

Once `GRAFANA_HOST`/`GRAFANA_ID`/`GRAFANA_SECRET` are configured (Netlify env vars in production, `.env` locally for the dev-server proxy), each node detail drawer (Invocation, Event, Job) has a "Logs" tab that displays relevant logs from Grafana Loki:

- **Invocation Logs**: All logs for the entire invocation (filtered by `invocationId`)
- **Event Logs**: Logs for a specific event execution and its jobs (filtered by `correlationId` and `eventExecutionId`)
- **Job Logs**: Logs for a specific job execution (filtered by `scopeId` and `jobExecutionId`)

The logs viewer features:
- **Live refresh** for running jobs
- **Multiple view modes**: Text, JSON, and Table
- **Search/filter** within logs
- **Copy to clipboard** in any format
- **Auto-scroll** for streaming logs

In production (Netlify), log requests go to `/api/grafana/*`, which is redirected to the `grafana-proxy` function (server-side basic auth). In local dev, the same path is proxied by Vite directly to the Loki host (see `vite.config.ts`), so behavior is identical in both environments (fixes bug B1 from the migration plan).

## Local database & seed data

See `db/local-setup.mjs` (one-time local wiring: creates the `event_detector_observability` database, applies `db/schema.sql`, and points the local Hasura `events` source at it) and `db/seed/seed.mjs` (deterministic seeder for realistic local data, defaults to 5,000 invocations; `npm run seed -- --invocations 200000` for the perf-scale dataset). Both are documented in `docs/planning/console-migration-plan.md` §8.

If Hasura reports the `events` source as inconsistent (e.g. after a container restart) and queries against `invocations`/`event_executions`/`job_executions` fail, re-run `npm run db:setup` — it re-points the source's connection string and reloads metadata; it's idempotent and safe to run any time.

## Perf baseline harness

`perf/measure.mjs` drives the app with headless Chromium (CPU 4x throttle + Fast-3G-ish network) and measures cold loads, search, facets, pagination, the drawer, the flow diagram, and hidden-tab polling — see `docs/planning/console-migration-plan.md` §8 for the full scenario list and targets. Run it against a seeded local dataset and a running dev server:

```
npm run dev        # in one terminal
npm run seed -- --invocations 200000
npm run perf        # writes perf/baseline.json + appends console/PERF.md
```

Note: at 200k rows under this throttle profile, a *fresh* page load of the dev server (unbundled ES modules, no code-splitting — see plan finding P9) itself takes on the order of a minute before any GraphQL query fires; this dwarfs query-level latency in the `cold-load-*` numbers today. Re-baseline against a production build (`vite build` + `vite preview`) once Phase C3's bundle diet lands to separate the two.

## Requirements

- Node.js >= 18
- PostgreSQL database for observability data (local: the `hopdrive-postgres` container from `hasura-migrations`)

## License

ISC
