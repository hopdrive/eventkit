---
'hopdrive-eventkit': minor
---

Ship the observability console as a mountable component from the package: `hopdrive-eventkit/console` (plus `hopdrive-eventkit/console/style.css`).

Instead of deploying the UI straight out of this repo (which made no sense once eventkit went open source), a consumer now stands it up with a tiny host wrapper that owns config + hosting and imports the console from the package. Scaffold one with `npx degit hopdrive/eventkit/console/template my-console`.

- New export `EventKitConsole` takes a `config` prop (`graphqlEndpoint`, `headers`, `auth`, `basename`, `grafanaProxyPath`). Nothing reads `import.meta.env` anymore, so one built artifact runs against any endpoint.
- Auth is injected by the wrapper. Pass `auth: { getHeaders, onUnauthenticated? }` and the console builds its Apollo client from it, resolving auth per request (a rotating JWT stays fresh without remounting). The wrapper owns login; the console owns the transport wiring.
- The console bundle inlines its UI libs (antd, reactflow, apollo, ...). Only `react` + `react-dom` are external (a single instance shared with the host) and they are the only peerDependencies, both optional — so a server/library consumer of the core installs neither. The wrapper only needs `react`, `react-dom`, and `hopdrive-eventkit`.
- The Grafana Loki proxy is now a host-agnostic function (`grafanaProxyCore.ts`) with a thin Netlify adapter, so any host can serve it.

Also folds in two console fixes carried on this branch: the `event_executions` status CHECK now allows `detection_failed`/`handler_failed` (legacy writer safety during migration), and the vite 8 / Rolldown `manualChunks` build fix.
