import React from 'react';
import ReactDOM from 'react-dom/client';
import { EventKitConsole, type EventKitConsoleConfig } from './EventKitConsole';

// Local dev / standalone browser entry. This is ALSO the reference the
// `create-eventkit-console` template copies: read your own env, build the
// config object, mount <EventKitConsole>. The published library
// (hopdrive-eventkit/console) exports the component; it does not read env.
const graphqlEndpoint = import.meta.env.VITE_GRAPHQL_ENDPOINT || 'http://localhost:8080/v1/graphql';
const headers: Record<string, string> | undefined = import.meta.env.VITE_HASURA_ADMIN_SECRET
  ? { 'x-hasura-admin-secret': import.meta.env.VITE_HASURA_ADMIN_SECRET }
  : undefined;

const config: EventKitConsoleConfig = {
  graphqlEndpoint,
  headers,

  // Optional: resolve origin emails to display profiles for the user-action
  // origin node. This dev harness looks the email up in a `users` table on the
  // SAME endpoint; your deployment can fetch from anywhere (a users table, an
  // IdP, a static map). Return null (or omit the resolver) to fall back to
  // initials + the raw email. Failures are treated as null, so it is safe to
  // point this harness at a database that has no users table at all.
  userResolver: async email => {
    try {
      const res = await fetch(graphqlEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(headers ?? {}) },
        body: JSON.stringify({
          query: 'query OriginUser($email: String!) { users(where: {email: {_eq: $email}}, limit: 1) { display_name avatar_url } }',
          variables: { email },
        }),
      });
      const user = (await res.json())?.data?.users?.[0];
      return user ? { displayName: user.display_name, avatarUrl: user.avatar_url } : null;
    } catch {
      return null;
    }
  },
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <EventKitConsole config={config} />
);
