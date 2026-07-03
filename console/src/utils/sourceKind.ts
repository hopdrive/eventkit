// Source-kind resolution for dynamic event sources (eventkit EventSourceType).
// `source_type` is the persisted category ('database' | 'webhook' | 'cron' | …,
// written by the observability plugin from ctx.sourceType); `source_system` is the
// adapter identity ('hasura', 'webhook:superdispatch'). Legacy rows (pre-eventkit,
// or written before source_type shipped) have source_type NULL — infer 'database'
// from a Hasura-shaped system/payload so old data keeps rendering correctly.

export type SourceKind =
  | 'database'
  | 'webhook'
  | 'cron'
  | 'action'
  | 'application'
  | 'queue'
  | 'manual'
  | 'unknown';

const KNOWN_KINDS: SourceKind[] = ['database', 'webhook', 'cron', 'action', 'application', 'queue', 'manual'];

export function resolveSourceKind(
  sourceType?: string | null,
  sourceSystem?: string | null,
  payload?: unknown
): SourceKind {
  if (sourceType && (KNOWN_KINDS as string[]).includes(sourceType)) return sourceType as SourceKind;
  if (sourceSystem?.startsWith('webhook')) return 'webhook';
  if (sourceSystem === 'hasura' || sourceSystem === 'supabase') return 'database';
  const p = payload as { event?: { data?: unknown } } | undefined;
  if (p?.event?.data !== undefined) return 'database'; // Hasura envelope shape
  return 'unknown';
}

/** Short display name for the source: 'hasura', 'webhook:superdispatch' → 'superdispatch'. */
export function sourceSystemLabel(sourceSystem?: string | null): string | undefined {
  if (!sourceSystem) return undefined;
  const idx = sourceSystem.indexOf(':');
  return idx >= 0 ? sourceSystem.slice(idx + 1) : sourceSystem;
}
