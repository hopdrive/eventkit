import React, { createContext, useContext } from 'react';

/**
 * Configuration for a mounted <EventKitConsole>.
 *
 * The console ships as a component from `hopdrive-eventkit/console`. All of
 * its environment coupling lives here: the host wrapper builds this object
 * (from its own env / auth) and passes it in. Nothing in the console reads
 * `import.meta.env` anymore, so one built artifact runs against any endpoint.
 */
/**
 * Auth strategy, defined by the host wrapper and injected into the console's
 * Apollo client. The wrapper owns login entirely (Firebase, Auth0, a password
 * gate, whatever); the console does not care HOW you authenticate. It only
 * needs two things from you: the headers to put on each GraphQL request, and
 * (optionally) a callback when Hasura rejects a request as unauthenticated.
 *
 * `getHeaders` is resolved BEFORE EVERY request (not once at mount), so a token
 * that rotates or that only exists after login is always current — you do not
 * rebuild or remount the console when the token changes.
 */
export interface EventKitConsoleAuth {
  /**
   * Auth headers for each GraphQL request, e.g.
   * `async () => ({ Authorization: \`Bearer ${await user.getIdToken()}\` })`.
   * Return `{}` while logged out. Merged over `config.headers`.
   */
  getHeaders: () => Record<string, string> | Promise<Record<string, string>>;

  /**
   * Called when Hasura rejects a request as unauthenticated (expired/invalid
   * JWT, or a 401). Use it to refresh the token or send the user back to login.
   * The console surfaces the error either way; this is just the hook to react.
   */
  onUnauthenticated?: (info: { message: string }) => void;
}

export interface EventKitConsoleConfig {
  /**
   * Hasura GraphQL endpoint for the observability source (the DB holding
   * `invocations` / `event_executions` / `job_executions`).
   */
  graphqlEndpoint: string;

  /**
   * Static headers merged into every GraphQL request. Use for a local-dev
   * `x-hasura-admin-secret`. Do NOT ship an admin secret to a public
   * deployment — use `auth` with a short-lived JWT and a read-only Hasura role.
   */
  headers?: Record<string, string>;

  /**
   * How the console authenticates GraphQL requests. Omit for local dev with a
   * static admin secret in `headers`; provide it to inject a JWT (or any
   * per-request auth) from the wrapper. See {@link EventKitConsoleAuth}.
   */
  auth?: EventKitConsoleAuth;

  /**
   * Router basename when the console is mounted under a sub-path (e.g.
   * '/console'). Defaults to '/'.
   */
  basename?: string;

  /**
   * Path the client hits for the Grafana Loki log proxy. The host must route
   * this prefix to a server-side proxy that injects Grafana basic-auth (see
   * `hopdrive-eventkit/console/server`). Defaults to '/api/grafana'. Set to
   * `null` to hide the log viewer when there is no proxy.
   */
  grafanaProxyPath?: string | null;
}

const DEFAULTS = {
  basename: '/',
  grafanaProxyPath: '/api/grafana' as string | null,
};

/** Resolved config with defaults applied — what components actually read. */
export type ResolvedConsoleConfig = EventKitConsoleConfig &
  Required<Pick<EventKitConsoleConfig, 'basename'>> & {
    grafanaProxyPath: string | null;
  };

const ConsoleConfigContext = createContext<ResolvedConsoleConfig | null>(null);

export function ConsoleConfigProvider({
  config,
  children,
}: {
  config: EventKitConsoleConfig;
  children: React.ReactNode;
}) {
  const resolved: ResolvedConsoleConfig = {
    ...config,
    basename: config.basename ?? DEFAULTS.basename,
    grafanaProxyPath:
      config.grafanaProxyPath === undefined ? DEFAULTS.grafanaProxyPath : config.grafanaProxyPath,
  };
  return <ConsoleConfigContext.Provider value={resolved}>{children}</ConsoleConfigContext.Provider>;
}

/**
 * Read the resolved console config. Throws if used outside <EventKitConsole>,
 * which is always a wiring bug rather than a runtime condition.
 */
export function useConsoleConfig(): ResolvedConsoleConfig {
  const ctx = useContext(ConsoleConfigContext);
  if (!ctx) {
    throw new Error('useConsoleConfig must be used within <EventKitConsole>');
  }
  return ctx;
}
