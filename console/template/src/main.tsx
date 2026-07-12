import React from 'react';
import ReactDOM from 'react-dom/client';
import { EventKitConsole, type EventKitConsoleConfig } from 'hopdrive-eventkit/console';
import 'hopdrive-eventkit/console/style.css';

// This wrapper's job: run YOUR auth however you like, then hand the console its
// config. The console owns everything else (pages, queries, UI). It does not
// care how you log in — it only needs `auth.getHeaders()` to authorize each
// GraphQL request. Wire your login (Firebase/Auth0/etc.) into getHeaders below.

// TODO(wrapper): replace with your real login. Return the current user's JWT,
// or null when logged out. getHeaders is called before every request, so a
// rotating token stays fresh without remounting the console.
async function getIdToken(): Promise<string | null> {
  return null;
}

const adminSecret = import.meta.env.VITE_HASURA_ADMIN_SECRET;

const config: EventKitConsoleConfig = {
  graphqlEndpoint: import.meta.env.VITE_GRAPHQL_ENDPOINT || 'http://localhost:8080/v1/graphql',

  // Local dev only: a static admin secret. Never ship this in a deployed build.
  headers: adminSecret ? { 'x-hasura-admin-secret': adminSecret } : undefined,

  // Production auth: inject a short-lived JWT (read-only observability_viewer
  // role). Omit this whole block for the local admin-secret path above.
  auth: adminSecret
    ? undefined
    : {
        getHeaders: async () => {
          const token = await getIdToken();
          return token ? { Authorization: `Bearer ${token}` } : {};
        },
        // Fired when Hasura rejects a request (expired/invalid JWT). Refresh or
        // bounce to login here.
        onUnauthenticated: () => {
          // e.g. redirectToLogin();
        },
      },

  // The log viewer fetches this prefix; the host routes it to the grafana
  // proxy (see netlify.toml + netlify/functions). Set to null to hide logs.
  grafanaProxyPath: '/api/grafana',
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <EventKitConsole config={config} />
  </React.StrictMode>
);
