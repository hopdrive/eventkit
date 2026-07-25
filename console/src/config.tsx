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

  /**
   * Optional lookup that turns the `source_user_email` on a chain root into a
   * display profile for the user-action origin node. The console is
   * deliberately schema-agnostic about identity: the host wrapper decides
   * where profiles live (a users table, an IdP, a static map) and returns a
   * name and avatar URL. Return null (or omit the resolver) and the node falls
   * back to the raw email with an initials avatar. Called lazily per distinct
   * email and cached for the life of the page; errors are treated as null.
   */
  userResolver?: (email: string) => OriginUserProfile | null | undefined | Promise<OriginUserProfile | null | undefined>;

  /**
   * Optional lookup that returns the EXPECTED flow graph for a source function,
   * so the canvas can overlay "what should happen" on "what did happen". The
   * console is deliberately schema-agnostic about where flows come from: the
   * host wrapper decides (a committed `*.flow.yaml`, a generated registry, a
   * static map) and returns the graph as plain data. Return null (or omit the
   * resolver) and an invocation renders exactly as it does today — no overlay,
   * no judgement. Called lazily per distinct `sourceFunction` and cached for the
   * life of the page; errors are treated as null.
   *
   * `at` is the invocation's start time (ISO). It is passed so a future host can
   * resolve the flow that was current when the run happened; today's hosts may
   * ignore it. See {@link ExpectedFlowGraph} for the exact shape to return — it
   * is `@hopdrive/eventkit`'s `toFlowGraph()` output plus optional metadata, so a
   * registry can emit it as plain JSON with no console-specific fields.
   */
  expectedFlowResolver?: (args: {
    sourceFunction: string;
    at?: string;
  }) => ExpectedFlowGraph | null | Promise<ExpectedFlowGraph | null>;
}

/** What {@link EventKitConsoleConfig.userResolver} returns for a known user. */
export interface OriginUserProfile {
  /** Human name shown instead of the raw email. */
  displayName?: string | null;
  /** Absolute image URL for the avatar; an initials circle renders when absent. */
  avatarUrl?: string | null;
}

// ── Expected-flow contract ──────────────────────────────────────────────────
//
// This is the wire contract between a flow PRODUCER (HopDrive's registry
// codegen, a committed `*.flow.yaml`, anything) and the console's overlay. It
// mirrors `@hopdrive/eventkit`'s `toFlowGraph()` output EXACTLY (src/core/flow.ts
// FlowNode/FlowEdge), so a producer can emit `toFlowGraph(kit)` as JSON, add the
// optional metadata, and hand it straight to `expectedFlowResolver`. Node ids
// MUST use the shared name-derived scheme (`source`, `event:<name>`,
// `job:<event>:<name>`, `sideEffect:<job>:<effect>`) or the observed-vs-expected
// overlay will not line up. Keep this to what `toFlowGraph` emits: no invented
// fields beyond the optional metadata below.

/** A node in an expected flow graph — `toFlowGraph()`'s `FlowNode`. */
export interface ExpectedFlowNode {
  /** Name-derived, stable across refactors. See the scheme above. */
  id: string;
  kind: 'source' | 'invocation' | 'event' | 'handler' | 'job' | 'sideEffect' | 'terminal';
  eventName?: string;
  jobName?: string;
  sourceFunction?: string;
  required?: boolean;
  condition?: string;
  metadata?: Record<string, unknown>;
}

/** An edge in an expected flow graph — `toFlowGraph()`'s `FlowEdge`. */
export interface ExpectedFlowEdge {
  from: string;
  to: string;
  required?: boolean;
  condition?: string;
}

/**
 * The expected flow for one source function: `toFlowGraph()`'s `{ nodes, edges }`
 * plus optional, non-load-bearing metadata a producer may attach (a human title,
 * when it was generated, a content hash for cache-busting). The overlay reads
 * only `nodes` and `edges`; the metadata is display sugar.
 */
export interface ExpectedFlowGraph {
  nodes: ExpectedFlowNode[];
  edges: ExpectedFlowEdge[];
  /** Human label for the flow (e.g. the function name). */
  title?: string;
  /** ISO timestamp of when the producer generated this graph. */
  generatedAt?: string;
  /** Opaque content hash the producer may set for cache-busting. */
  hash?: string;
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
