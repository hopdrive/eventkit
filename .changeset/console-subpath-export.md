---
'hopdrive-eventkit': minor
---

Ship the observability console as a mountable component from the package: `hopdrive-eventkit/console` (plus `hopdrive-eventkit/console/style.css`).

Instead of deploying the UI straight out of this repo (which made no sense once eventkit went open source), a consumer now stands it up with a tiny host wrapper that owns config + hosting and imports the console from the package. Scaffold one with `npx degit hopdrive/eventkit/console/template my-console`.

- New export `EventKitConsole` takes a `config` prop (`graphqlEndpoint`, `headers`/`getHeaders`, `basename`, `grafanaProxyPath`). Nothing reads `import.meta.env` anymore, so one built artifact runs against any endpoint.
- The UI libs (react, antd, reactflow, apollo, ...) are **optional** peerDependencies, so a server/library consumer of the core never installs them. The wrapper template lists them as real dependencies.
- The Grafana Loki proxy is now a host-agnostic function (`grafanaProxyCore.ts`) with a thin Netlify adapter, so any host can serve it.

Also folds in two console fixes carried on this branch: the `event_executions` status CHECK now allows `detection_failed`/`handler_failed` (legacy writer safety during migration), and the vite 8 / Rolldown `manualChunks` build fix.
