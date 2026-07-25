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

  // Optional: resolve a source function to its EXPECTED flow graph, so the canvas
  // can overlay "what should happen" on "what did happen" per invocation. A real
  // deployment points this at its committed *.flow.yaml or a generated registry
  // (HopDrive's registry codegen emits exactly this ExpectedFlowGraph shape as
  // JSON). This dev harness returns one static example, derived from the seeded
  // showcase chain's shape (source_function 'event-handlers', event
  // 'move.create.requested' -> job 'requestVehicleMove') plus ONE extra step the
  // seed never records ('move.audit.recorded' -> 'writeMoveAuditLog'), so the
  // overlay always has an expected-but-missing ghost to show. `at` is ignored
  // here; a future host could use it to resolve the flow current at run time.
  expectedFlowResolver: ({ sourceFunction }) => {
    if (sourceFunction !== 'event-handlers') return null;
    return {
      title: 'event-handlers (example)',
      generatedAt: '2026-07-24T00:00:00.000Z',
      nodes: [
        { id: 'source', kind: 'source', sourceFunction: 'event-handlers' },
        { id: 'event:move.create.requested', kind: 'event', eventName: 'move.create.requested' },
        { id: 'job:move.create.requested:requestVehicleMove', kind: 'job', jobName: 'requestVehicleMove' },
        { id: 'event:move.audit.recorded', kind: 'event', eventName: 'move.audit.recorded' },
        { id: 'job:move.audit.recorded:writeMoveAuditLog', kind: 'job', jobName: 'writeMoveAuditLog' },
      ],
      edges: [
        { from: 'source', to: 'event:move.create.requested' },
        { from: 'event:move.create.requested', to: 'job:move.create.requested:requestVehicleMove' },
        { from: 'source', to: 'event:move.audit.recorded' },
        { from: 'event:move.audit.recorded', to: 'job:move.audit.recorded:writeMoveAuditLog' },
      ],
    };
  },
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <EventKitConsole config={config} />
);
