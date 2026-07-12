import React from 'react';
import ReactDOM from 'react-dom/client';
import { EventKitConsole, type EventKitConsoleConfig } from 'hopdrive-eventkit/console';
import 'hopdrive-eventkit/console/style.css';

// This wrapper's ONLY job: read your environment and hand the console its
// config. The console owns everything else — pages, queries, UI. Because the
// config flows in from THIS app's build, the same published console runs
// against any endpoint; nothing is baked into the library.
const config: EventKitConsoleConfig = {
  graphqlEndpoint: import.meta.env.VITE_GRAPHQL_ENDPOINT || 'http://localhost:8080/v1/graphql',

  // Local dev only. For a deployed site, DO NOT ship an admin secret — use a
  // short-lived JWT via `getHeaders` against a read-only Hasura role instead:
  //   getHeaders: async () => ({ Authorization: `Bearer ${await getToken()}` }),
  headers: import.meta.env.VITE_HASURA_ADMIN_SECRET
    ? { 'x-hasura-admin-secret': import.meta.env.VITE_HASURA_ADMIN_SECRET }
    : undefined,

  // The log viewer fetches this prefix; the host routes it to the grafana
  // proxy (see netlify.toml + netlify/functions). Set to null to hide logs.
  grafanaProxyPath: '/api/grafana',
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <EventKitConsole config={config} />
  </React.StrictMode>
);
