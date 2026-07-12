import React, { createContext, useContext } from 'react';

/**
 * Configuration for a mounted <EventKitConsole>.
 *
 * The console ships as a component from `hopdrive-eventkit/console`. All of
 * its environment coupling lives here: the host wrapper builds this object
 * (from its own env / auth) and passes it in. Nothing in the console reads
 * `import.meta.env` anymore, so one built artifact runs against any endpoint.
 */
export interface EventKitConsoleConfig {
  /**
   * Hasura GraphQL endpoint for the observability source (the DB holding
   * `invocations` / `event_executions` / `job_executions`).
   */
  graphqlEndpoint: string;

  /**
   * Static headers merged into every GraphQL request. Use for a local-dev
   * `x-hasura-admin-secret`, or a fixed bearer token. Do NOT ship an admin
   * secret to a public deployment — prefer `getHeaders` with a short-lived
   * JWT and a read-only Hasura role.
   */
  headers?: Record<string, string>;

  /**
   * Per-request header provider, resolved before each GraphQL call and
   * merged over `headers`. Use for JWTs that rotate (e.g. Firebase). Async
   * so the wrapper can refresh a token on demand.
   */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;

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
