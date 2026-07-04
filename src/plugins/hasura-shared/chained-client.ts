// =============================================================================
// eventkit/sources/hasura — hasuraChainedClient (ADR-039.4)
// =============================================================================
// The eventkit-native paved road for OUTBOUND token injection. Chain placement
// (ADR-039) puts each concern in its layer: EventKit provides the token
// (`ctx.trackingToken`, minted by loop-guard); ATTACHING it to a write belongs to
// whoever owns the write. This helper is that write layer for jobs that talk to
// Hasura directly — a fetch wrapper that stamps `x-hasura-tracking-token:
// ctx.trackingToken` onto every request, so the header channel (Hasura forwards
// `x-hasura-*` request headers on admin-secret calls into the next event's
// session_variables) carries the lineage with zero row pollution.
//
// It plugs into the EXISTING ADR-020 input-baseline seam (`augmentJobContext →
// { input }`): the plugin contributes `ctx.input.gql`, so a job consumes it as
// `const { gql } = ctx.input` and stays plugin-agnostic. Nothing new in the
// contract — this is the seam that ADR-039 found unused (the E2E proof hand-rolled
// a `gqlWithToken` in job code). It ships WITH the Hasura source package because
// the channel (header name → session_variables) is Hasura-specific knowledge; the
// durable org-wide answer for the same job stays the sdk-* write family attaching
// the header itself. Endpoint + headers are injected config (secrets live here,
// never process.env); dependency-free, fetch-based — mirrors graphqlSink.
import type { EventKitPlugin, JobContext } from '../../core/index.js';

export interface HasuraChainedClientConfig {
  /** Hasura GraphQL endpoint. */
  endpoint: string;
  /** Request headers — `{ 'x-hasura-admin-secret': '…' }`. Secrets are injected config, never process.env. */
  headers?: Record<string, string>;
  /** Per-request timeout (ms). Default 30000 (mirrors graphqlSink). */
  timeoutMs?: number;
}

/** The `gql` function jobs consume from `ctx.input`. */
export type GqlFunction = (query: string, variables?: Record<string, unknown>) => Promise<unknown>;

/** A GraphQL-level error (the response body carried an `errors` array). */
export class GraphqlRequestError extends Error {
  override readonly name = 'GraphqlRequestError';
  constructor(public readonly errors: unknown[]) {
    super(`GraphQL errors: ${JSON.stringify(errors)}`);
  }
}

export function hasuraChainedClient(config: HasuraChainedClientConfig): EventKitPlugin {
  if (!config?.endpoint) throw new Error('hasuraChainedClient() requires an `endpoint`.');
  const timeoutMs = config.timeoutMs ?? 30000;
  const baseHeaders = { 'content-type': 'application/json', ...(config.headers ?? {}) };

  return {
    name: 'hasura-chained-client',

    augmentJobContext(ctx: JobContext) {
      const gql: GqlFunction = async (query, variables) => {
        // Read the token LAZILY at call time: `augmentJobContext` runs BEFORE the
        // runtime assigns `ctx.trackingToken` onto this same ctx object (see run.ts),
        // so capturing it at contribution time would always read undefined.
        const headers: Record<string, string> = { ...baseHeaders };
        const token = ctx.trackingToken;
        if (typeof token === 'string' && token.length > 0) headers['x-hasura-tracking-token'] = token;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(config.endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({ query, variables }),
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
          const body = (await res.json()) as { data?: unknown; errors?: unknown[] } | null | undefined;
          const errors = body?.errors;
          if (errors && errors.length) throw new GraphqlRequestError(errors);
          return body?.data;
        } finally {
          clearTimeout(timer);
        }
      };

      return { input: { gql } };
    },
  };
}
