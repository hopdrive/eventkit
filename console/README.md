# @hopdrive/eventkit-console

Observability Console UI for EventKit (and legacy Hasura Event Detector — schema-compatible during the runtime migration).

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy the env template and fill in local values
cp .env.example .env

# 3. Start the dev server
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

# Start development server
npm run dev

# Build for production
npm run build

# Regenerate GraphQL types from the schema in VITE_GRAPHQL_ENDPOINT
npm run codegen
```

## Configuration

All configuration is via environment variables — see `.env.example`. There is no `console.config.js`; do not reintroduce one (it previously held a hard-coded admin secret).

- `VITE_GRAPHQL_ENDPOINT` — Hasura GraphQL endpoint
- `VITE_HASURA_ADMIN_SECRET` — **local dev only**; never set this in a deployed environment (see `docs/planning/console-migration-plan.md` §5/S1 for the planned `observability_viewer` role + JWT auth)
- `GRAFANA_HOST`, `GRAFANA_ID`, `GRAFANA_SECRET` — server-side only, consumed by the Netlify function proxy (`netlify/functions/grafana-proxy.ts`), never exposed to the client bundle

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

See `db/local-setup.mjs` (one-time local wiring: creates the `event_detector_observability` database, applies `db/schema.sql`, and points the local Hasura `events` source at it) and `db/seed/seed.mjs` (deterministic seeder for realistic local data). Both are documented in `docs/planning/console-migration-plan.md` §8.

## Requirements

- Node.js >= 18
- PostgreSQL database for observability data (local: the `hopdrive-postgres` container from `hasura-migrations`)

## License

ISC
