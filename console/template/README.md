# EventKit Console (host wrapper)

A minimal site that mounts the EventKit observability console. It imports the UI
from [`hopdrive-eventkit/console`](https://www.npmjs.com/package/hopdrive-eventkit)
and does one thing itself: hand the console your endpoint and auth. All the pages,
queries, and UI live in the package, so upgrading the console is a version bump
here, not a re-fork.

> First time? This template is only the front end. The full setup (observability
> database, Hasura source + relationships, read-only role, and the eventkit
> writer) is in the console's
> [getting-started guide](https://github.com/hopdrive/eventkit/blob/main/console/docs/getting-started.md).

## Scaffold it

```bash
npx degit hopdrive/eventkit/console/template my-eventkit-console
cd my-eventkit-console
npm install
cp .env.example .env   # set VITE_GRAPHQL_ENDPOINT
npm run dev
```

## What's in here

| File | Why it exists |
|------|----------------|
| `src/main.tsx` | Reads env, builds the config, renders `<EventKitConsole>`. The one file you customize. |
| `index.html` | SPA entry + fonts. |
| `vite.config.ts` | Dev server + `/api/grafana` proxy for local log viewing. |
| `netlify.toml` | Build, the `/api/grafana` redirect, SPA fallback. |
| `netlify/functions/` | The Grafana Loki proxy (keeps Grafana creds server-side). Delete if you don't use logs. |
| `.env.example` | Documents every setting. |

## Configuration

Everything is passed to `<EventKitConsole config={...} />` in `src/main.tsx`:

- `graphqlEndpoint` — Hasura endpoint for the observability DB (`invocations` /
  `event_executions` / `job_executions`).
- `headers` — static headers per GraphQL request. Fine for a local
  `x-hasura-admin-secret`; never for a deployed build.
- `getHeaders` — async per-request headers. Use for a rotating JWT:
  `getHeaders: async () => ({ Authorization: \`Bearer ${await getToken()}\` })`.
- `basename` — mount under a sub-path (default `/`).
- `grafanaProxyPath` — where the log viewer fetches (default `/api/grafana`);
  set `null` to hide logs.

## Deploying anywhere

The build is a static SPA (`dist/`) plus one optional function (the Grafana
proxy). The `netlify.toml` here is one example. On any host: serve `dist/`, route
`/api/grafana/*` to the proxy, and SPA-fallback everything else to `index.html`.

## Security

Do not ship an admin secret to a public deployment — anything in the client
bundle is readable. Point the console at a read-only Hasura role
(`observability_viewer`, select-only on the observability tables) and send a
short-lived JWT via `getHeaders`. Grafana credentials stay server-side in the
proxy function (`GRAFANA_*`, never `VITE_`-prefixed).

## Provisioning the database

The console reads three tables. The schema + indexes live in the eventkit repo
at `console/db/schema.sql`, and the Hasura metadata for the `events` source in
`hasura-migrations`. See the console migration plan in the eventkit repo.
