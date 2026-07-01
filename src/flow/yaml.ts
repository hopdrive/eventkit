// A minimal, dependency-free YAML emitter for the constrained flow-doc schema
// (maps, lists, and scalars: string | number | boolean). Not a general YAML
// library — it emits the shapes this package produces, deterministically, so the
// committed artifact diffs cleanly. `undefined`/`null` values are omitted; empty
// arrays render as `[]`; scalar arrays use flow style (`[a, b]`), object/array
// arrays use block style.

type Json = string | number | boolean | null | undefined | Json[] | { [k: string]: Json };

const RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~', '']);
// Chars that force quoting when they LEAD a plain scalar (YAML indicators).
const LEADING_INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;

function needsQuote(s: string): boolean {
  if (RESERVED.has(s.toLowerCase())) return true;
  if (LEADING_INDICATOR.test(s)) return true;
  if (/^\s|\s$/.test(s)) return true; // leading/trailing whitespace
  if (s.includes(': ') || s.endsWith(':')) return true; // key/value ambiguity
  if (s.includes(' #')) return true; // inline-comment ambiguity
  if (s.includes('\n')) return true;
  if (/^[+-]?(\d[\d_]*\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return true; // looks numeric
  return false;
}

function scalar(v: string | number | boolean): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : `"${String(v)}"`;
  if (!needsQuote(v)) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

const isScalar = (v: Json): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

const isPlainObject = (v: Json): v is { [k: string]: Json } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Drop keys whose value is `undefined`/`null` so optional fields don't render. */
function entries(obj: { [k: string]: Json }): [string, Json][] {
  return Object.entries(obj).filter(([, v]) => v !== undefined && v !== null);
}

function emit(value: Json, indent: number, lines: string[]): void {
  const pad = '  '.repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines[lines.length - 1] += ' []';
      return;
    }
    // All-scalar arrays → flow style on the same line as the key.
    if (value.every(isScalar)) {
      lines[lines.length - 1] += ` [${value.map(v => scalar(v as string | number | boolean)).join(', ')}]`;
      return;
    }
    for (const item of value) {
      if (isPlainObject(item)) {
        const es = entries(item);
        if (es.length === 0) {
          lines.push(`${pad}- {}`);
          continue;
        }
        // First key sits on the dash line; the rest indent under it.
        const [firstKey, firstVal] = es[0]!;
        lines.push(`${pad}- ${firstKey}:`);
        emitValueInline(firstKey, firstVal, indent + 1, lines);
        for (const [k, v] of es.slice(1)) {
          lines.push(`${'  '.repeat(indent + 1)}${k}:`);
          emitValueInline(k, v, indent + 1, lines);
        }
      } else {
        lines.push(`${pad}- ${scalar(item as string | number | boolean)}`);
      }
    }
    return;
  }

  if (isPlainObject(value)) {
    for (const [k, v] of entries(value)) {
      lines.push(`${pad}${k}:`);
      emitValueInline(k, v, indent, lines);
    }
    return;
  }

  lines[lines.length - 1] += ` ${scalar(value as string | number | boolean)}`;
}

// Emit a value for a key whose `key:` line was just pushed: scalars/flow-arrays
// append to that line; nested maps/block-arrays continue on following lines.
function emitValueInline(_key: string, v: Json, indent: number, lines: string[]): void {
  if (isScalar(v)) {
    lines[lines.length - 1] += ` ${scalar(v)}`;
  } else if (Array.isArray(v)) {
    emit(v, indent + 1, lines);
  } else if (isPlainObject(v)) {
    if (entries(v).length === 0) {
      lines[lines.length - 1] += ' {}';
    } else {
      emit(v, indent + 1, lines);
    }
  }
}

/** Serialize a plain object to deterministic block-style YAML. */
export function toYaml(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  emit(obj as Json, 0, lines);
  return lines.join('\n') + '\n';
}
