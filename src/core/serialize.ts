// =============================================================================
// Shared serialization guards (D13, §9.4/§12.4)
// =============================================================================
// The persisted channels (job metadata, job result/output, source payload) MUST be
// JSON-serializable. Two guards, shared by Batch (durability) and Observability:
//   • `getNonSerializableLabel` / `stripNonSerializable` — duck-type known live
//     infrastructure clients (an SDK, an Apollo Client, a graphql-request client) and
//     replace them with a marker, so a misplaced live client degrades gracefully
//     instead of corrupting the write.
//   • `assertSerializableMetadata` — fail-fast: throw a clear error NAMING the first
//     non-serializable key path, so a bad `metadata` is caught loudly, not silently
//     mangled at persist time.

/** Duck-type a known non-serializable infrastructure client; returns a label or null. */
export function getNonSerializableLabel(value: Record<string, unknown>): string | null {
  const v = value as Record<string, unknown> & {
    apollo?: unknown;
    config?: { apollo_client?: unknown };
    gql?: { query?: unknown; mutation?: unknown };
    queryManager?: unknown;
    cache?: unknown;
    link?: unknown;
    url?: unknown;
    request?: unknown;
    rawRequest?: unknown;
  };
  // SDK wrapping an Apollo client (e.g. @hopdrive/sdk) — check before Apollo itself.
  if (v.apollo && typeof v.apollo === 'object') return 'sdk';
  if (v.config?.apollo_client) return 'sdk';
  if (v.gql && typeof v.gql.query === 'function' && typeof v.gql.mutation === 'function') return 'sdk';
  // Apollo Client instance.
  if (v.queryManager && v.cache && v.link) return 'Apollo Client';
  // graphql-request-style client.
  if (v.url && typeof v.request === 'function' && typeof v.rawRequest === 'function') return 'GraphQL client';
  return null;
}

/**
 * Walk a value and replace live clients / functions with markers, preserving the rest
 * of the structure (depth-limited, circular-safe). Use before persisting a job result
 * so a misplaced live client is stripped rather than crashing/corrupting the write.
 */
export function stripNonSerializable(value: unknown, maxDepth = 10): unknown {
  const walk = (val: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (val === null || val === undefined) return val;
    const t = typeof val;
    if (t === 'string' || t === 'number' || t === 'boolean') return val;
    if (t === 'function') return '[Function]';
    if (t === 'bigint') return (val as bigint).toString();
    if (t === 'symbol') return String(val);
    if (t !== 'object') return String(val);

    const obj = val as object;
    const label = getNonSerializableLabel(obj as Record<string, unknown>);
    if (label) return `[${label} excluded]`;
    if (seen.has(obj)) return '[Circular]';
    if (depth >= maxDepth) {
      const name = (obj as { constructor?: { name?: string } })?.constructor?.name;
      return Array.isArray(obj) ? `[Array(${obj.length})]` : `[${name || 'Object'}(${Object.keys(obj).length} keys)]`;
    }
    seen.add(obj);
    try {
      if (obj instanceof Date) return obj.toISOString();
      if (obj instanceof Error) return { name: obj.name, message: obj.message };
      if (Array.isArray(obj)) return obj.map(item => walk(item, depth + 1, seen));
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = walk(v, depth + 1, seen);
      return out;
    } finally {
      seen.delete(obj);
    }
  };
  return walk(value, 0, new WeakSet());
}

/** Thrown by `assertSerializableMetadata` naming the offending key path. */
export class NonSerializableMetadataError extends Error {
  override readonly name = 'NonSerializableMetadataError';
  constructor(public readonly keyPath: string, reason: string) {
    super(`Non-serializable job metadata at '${keyPath}': ${reason}. Job metadata MUST be JSON-serializable (§9.4) — live clients/closures belong in \`input\`, not \`metadata\`.`);
  }
}

/**
 * Fail-fast: throw if `metadata` holds anything that won't survive JSON persistence —
 * a function/closure, symbol, bigint, a live infrastructure client, or a circular
 * reference — NAMING the first offending key path. Used by Batch before it persists.
 */
export function assertSerializableMetadata(metadata: unknown, label = 'metadata'): void {
  const visit = (val: unknown, path: string, seen: WeakSet<object>): void => {
    if (val === null || val === undefined) return;
    const t = typeof val;
    if (t === 'string' || t === 'number' || t === 'boolean') return;
    if (t === 'function') throw new NonSerializableMetadataError(path, 'a function/closure');
    if (t === 'symbol') throw new NonSerializableMetadataError(path, 'a symbol');
    if (t === 'bigint') throw new NonSerializableMetadataError(path, 'a bigint');
    if (t !== 'object') throw new NonSerializableMetadataError(path, `a ${t}`);

    const obj = val as object;
    const clientLabel = getNonSerializableLabel(obj as Record<string, unknown>);
    if (clientLabel) throw new NonSerializableMetadataError(path, `a live ${clientLabel}`);
    if (seen.has(obj)) throw new NonSerializableMetadataError(path, 'a circular reference');
    if (obj instanceof Date || obj instanceof Error) return; // serialize cleanly
    seen.add(obj);
    try {
      if (Array.isArray(obj)) obj.forEach((item, i) => visit(item, `${path}[${i}]`, seen));
      else for (const [k, v] of Object.entries(obj)) visit(v, `${path}.${k}`, seen);
    } finally {
      seen.delete(obj);
    }
  };
  visit(metadata, label, new WeakSet());
}
