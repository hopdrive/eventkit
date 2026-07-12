import React from 'react';
import ReactDOM from 'react-dom/client';
import { EventKitConsole, type EventKitConsoleConfig } from './EventKitConsole';

// Local dev / standalone browser entry. This is ALSO the reference the
// `create-eventkit-console` template copies: read your own env, build the
// config object, mount <EventKitConsole>. The published library
// (hopdrive-eventkit/console) exports the component; it does not read env.
const config: EventKitConsoleConfig = {
  graphqlEndpoint: import.meta.env.VITE_GRAPHQL_ENDPOINT || 'http://localhost:8080/v1/graphql',
  headers: import.meta.env.VITE_HASURA_ADMIN_SECRET
    ? { 'x-hasura-admin-secret': import.meta.env.VITE_HASURA_ADMIN_SECRET }
    : undefined,
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <EventKitConsole config={config} />
);
