// =============================================================================
// Source-meta convention (well-known envelope.meta keys)
// =============================================================================
// A source adapter knows things about the inbound event that downstream
// infrastructure plugins (observability) want, but the plugins MUST stay
// source-agnostic. The bridge: a source SURFACES those attributes into
// `envelope.meta` under these well-known keys, and a plugin READS them
// generically — no plugin ever parses a source-specific payload.
//
// Every key is optional. A source populates the ones it can; a reader treats a
// missing key as "unknown". This is data on the envelope, not behavior.

export interface SourceMeta {
  /**
   * The source's business-meaningful function/handler identity (Hasura trigger
   * name, e.g. `'db-appointments'`). Observability prefers this for
   * `source_function` over the platform's runtime function name, which can be
   * unreliable (e.g. `'handler'` under `netlify dev`).
   */
  sourceFunction?: string;
  /** Fully-qualified source object, e.g. `'public.appointments'` (Hasura schema.table). */
  sourceTable?: string;
  /** Source operation, e.g. a Hasura op `'INSERT' | 'UPDATE' | 'DELETE' | 'MANUAL'`. */
  sourceOperation?: string;
  /** Source-assigned event id (Hasura `id`). */
  sourceEventId?: string;
  /** Acting user's email, if the source carries identity (Hasura session vars). */
  sourceUserEmail?: string;
  /** Acting user's role, if the source carries identity. */
  sourceUserRole?: string;
  /**
   * The prior job execution id that produced the write which triggered this
   * invocation — the observability link back to `batch_jobs`/`job_executions`.
   * Populated by loop-prevention from the inbound tracking token (§13).
   */
  sourceJobId?: string;
  /** Inbound provenance token (loop-prevention). */
  sourceTrackingToken?: string;
}

/** The well-known key names, for writers/readers that prefer constants over literals. */
export const SOURCE_META_KEYS = {
  sourceFunction: 'sourceFunction',
  sourceTable: 'sourceTable',
  sourceOperation: 'sourceOperation',
  sourceEventId: 'sourceEventId',
  sourceUserEmail: 'sourceUserEmail',
  sourceUserRole: 'sourceUserRole',
  sourceJobId: 'sourceJobId',
  sourceTrackingToken: 'sourceTrackingToken',
} as const satisfies Record<keyof SourceMeta, string>;
