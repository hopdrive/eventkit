// Safe JSON serialization for persisted observability fields. Ported from the
// legacy plugin's safeSerialize/sanitizeJobOptions: known non-serializable
// infrastructure clients (an SDK, an Apollo Client, a graphql-request client) are
// duck-typed and excluded immediately; everything else is walked to a depth limit
// (a safety net for unknown circular structures) and over-large payloads are
// summarized. This guards `source_event_payload`, job `result`, and job metadata.
// The live-client duck-typing is shared with Batch via core (D13).
import { getNonSerializableLabel } from '../../core/index.js';

const walk = (value: unknown, depth: number, maxDepth: number, seen: WeakSet<object>): unknown => {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'function') return '[Function]';
  if (t === 'bigint') return (value as bigint).toString();
  if (t === 'symbol') return String(value);
  if (t !== 'object') return String(value);

  const obj = value as object;
  const label = getNonSerializableLabel(obj as Record<string, unknown>);
  if (label) return `[${label} excluded]`;

  if (seen.has(obj)) return '[Circular]';

  if (depth >= maxDepth) {
    const name = (obj as { constructor?: { name?: string } })?.constructor?.name;
    if (Array.isArray(obj)) return `[Array(${obj.length})]`;
    return `[${name || 'Object'}(${Object.keys(obj).length} keys)]`;
  }

  seen.add(obj);
  try {
    if (obj instanceof Date) return obj.toISOString();
    if (obj instanceof Error) return { name: obj.name, message: obj.message };
    if (Array.isArray(obj)) return obj.map(item => walk(item, depth + 1, maxDepth, seen));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) out[k] = walk(val, depth + 1, maxDepth, seen);
    return out;
  } finally {
    seen.delete(obj);
  }
};

/**
 * Serialize a value for persistence. Returns `null` (and logs nothing) if the
 * result would exceed `maxJsonSize` bytes, matching the legacy size guard.
 */
export function safeSerialize(value: unknown, opts: { maxDepth?: number; maxJsonSize?: number } = {}): unknown {
  if (value === null || value === undefined) return null;
  const result = walk(value, 0, opts.maxDepth ?? 10, new WeakSet());
  if (opts.maxJsonSize) {
    try {
      if (JSON.stringify(result).length > opts.maxJsonSize) {
        return { __truncated: true, reason: `exceeded maxJsonSize ${opts.maxJsonSize}` };
      }
    } catch {
      return { __truncated: true, reason: 'unserializable' };
    }
  }
  return result;
}
