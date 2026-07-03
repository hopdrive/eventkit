// =============================================================================
// Hasura inbound tracking-token discovery (ADR-039.2)
// =============================================================================
// The ONLY place that knows where a Hasura payload carries a tracking token. A
// Hasura source reads its two channels during normalize and surfaces ordered
// candidates on `envelope.meta.tokenCandidates`; `loopGuard` consumes them and
// stays generic. The two channels:
//   • the row write field (`updated_by`, configurable) — the persistent channel;
//   • session variables (`x-hasura-tracking-token` by default) — the zero-persistence
//     header channel (`x-hasura-*` request headers forwarded into event.session_variables).

export interface HasuraTokenDiscoveryConfig {
  /**
   * The row write field checked first. Default `'updated_by'`. `'updatedby'` and
   * `'updated_by'` are always checked as fallbacks after the configured field
   * (mirroring the legacy `row[field] ?? row['updatedby'] ?? row['updated_by']`).
   */
  tokenField?: string;
  /** Session-variable names checked in order. Default `['x-hasura-tracking-token']`. */
  tokenSessionVariables?: string[];
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/**
 * Ordered inbound token candidates for a Hasura payload: write-field values first
 * (configured field, then `updatedby`/`updated_by` fallbacks), then session
 * variables. Non-empty strings only, deduped; empty array when nothing is found.
 */
export function collectTokenCandidates(
  row: Record<string, unknown> | null,
  session: Record<string, unknown> | null,
  config: HasuraTokenDiscoveryConfig,
): string[] {
  const field = config.tokenField ?? 'updated_by';
  const sessionVariables = config.tokenSessionVariables ?? ['x-hasura-tracking-token'];
  const out: string[] = [];
  const push = (v: string | undefined): void => {
    if (v && !out.includes(v)) out.push(v);
  };

  if (row) {
    push(asString(row[field]));
    push(asString(row['updatedby']));
    push(asString(row['updated_by']));
  }
  if (session) {
    for (const name of sessionVariables) push(asString(session[name]));
  }
  return out;
}
