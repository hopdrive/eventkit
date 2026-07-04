// =============================================================================
// eventkit/testing — event-name ↔ filename validator
// =============================================================================
// A test-time check that each event module's declared `name` exactly matches its
// file name (the ADR-025 / one-module-per-file convention, e.g. `appointment.ready.ts`
// → `defineEvent({ name: 'appointment.ready' })`). TypeScript cannot tie a string
// literal to a filename, so this runs at test/CI time — but it reads SOURCE TEXT
// (never imports the module), so it has no import side effects, needs no env, and
// is unaffected by bundling. An "event module" is discovered as any scanned file
// that contains a `defineEvent({ … })` call; everything else is skipped, so it
// safely coexists with dispatchers, jobs, helpers, and legacy modules. The check is
// exact: the filename stem (basename minus its extension) must equal the name — no
// suffix stripping, no configuration.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

export interface EventNameMismatch {
  /** Absolute or cwd-relative path of the offending file. */
  file: string;
  /** The name the file SHOULD declare (its filename stem after stripping suffixes). */
  expected: string;
  /** The `name` literal found in the file, or null if none/non-literal was found. */
  actual: string | null;
  reason: 'mismatch' | 'missing-name';
}

export interface ValidateEventNamesOptions {
  /** Directory (or directories) to scan recursively for event modules. */
  dir: string | string[];
  /** File extensions considered source. Default: ts/tsx/js/jsx/mjs/cjs. */
  extensions?: string[];
  /** Directory names skipped during the scan. Default: node_modules/dist/build/coverage/.git. */
  ignore?: string[];
}

const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const DEFAULT_IGNORE = ['node_modules', 'dist', 'build', 'coverage', '.git'];

// A `defineEvent({ … })` call (optionally generic, e.g. `defineEvent<Row>({…})`). The
// leading lookbehind avoids matching an identifier that merely ends in `defineEvent`.
// Requiring `({` means the `defineEvent` FUNCTION DEFINITION (`defineEvent<…>(module:`)
// is not mistaken for a call. The trailing `{` is the start of the module object.
const DEFINE_EVENT_CALL = /(?<![A-Za-z0-9_$])defineEvent\s*(?:<[^>]*>)?\s*\(\s*\{/;

const isIdentChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/**
 * Extract the module object's TOP-LEVEL `name` string literal from source. Returns the
 * literal, `null` if `defineEvent({…})` is present but its top-level `name` is missing or
 * non-literal (computed), or `undefined` if there is no `defineEvent({…})` call at all.
 * Scans with brace/bracket depth and skips strings + comments, so a nested job's
 * `{ name: '…' }` (or a `name` inside the detector) is never mistaken for the event name,
 * regardless of property order.
 */
function extractTopLevelName(src: string): string | null | undefined {
  const call = DEFINE_EVENT_CALL.exec(src);
  if (!call) return undefined;
  const n = src.length;
  let i = call.index + call[0].length; // index just AFTER the module object's opening `{`
  let depth = 1;
  while (i < n && depth > 0) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (ch === '{' || ch === '[' || ch === '(') { depth++; i++; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth--; i++; continue; }
    if (depth === 1 && ch === 'n' && src.startsWith('name', i) && !isIdentChar(src[i - 1]) && !isIdentChar(src[i + 4])) {
      let j = i + 4;
      while (j < n && /\s/.test(src[j]!)) j++;
      if (src[j] === ':') {
        j++;
        while (j < n && /\s/.test(src[j]!)) j++;
        const q = src[j];
        if (q === '"' || q === "'" || q === '`') {
          let k = j + 1;
          let val = '';
          while (k < n && src[k] !== q) {
            if (src[k] === '\\') { val += src[k + 1] ?? ''; k += 2; continue; }
            val += src[k];
            k++;
          }
          return val;
        }
        return null; // name present but its value is non-literal (computed)
      }
    }
    i++;
  }
  return null; // the module object had no top-level `name`
}

function walk(dir: string, ignore: string[], extensions: string[], out: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir); // names only — avoids @types/node Dirent<Buffer> union noise
  } catch {
    return; // a missing/unreadable directory contributes nothing
  }
  for (const name of names) {
    if (ignore.includes(name)) continue;
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      walk(full, ignore, extensions, out);
    } else if (
      extensions.some(e => name.endsWith(e)) &&
      !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) &&
      !name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
}

/** The filename stem: basename minus its extension (e.g. `appointment.ready.ts` → `appointment.ready`). */
function stemOf(file: string, extensions: string[]): string {
  const name = basename(file);
  for (const ext of extensions) {
    if (name.endsWith(ext)) return name.slice(0, -ext.length);
  }
  return name;
}

/**
 * Scan `options.dir` for event modules (files that call `defineEvent({ … })`) and
 * return every one whose declared `name` does not match its filename stem. An empty
 * array means all event modules are consistent.
 */
export function findEventNameMismatches(options: ValidateEventNamesOptions): EventNameMismatch[] {
  const dirs = Array.isArray(options.dir) ? options.dir : [options.dir];
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS;
  const ignore = options.ignore ?? DEFAULT_IGNORE;

  const files: string[] = [];
  for (const d of dirs) walk(d, ignore, extensions, files);

  const mismatches: EventNameMismatch[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const actual = extractTopLevelName(src);
    if (actual === undefined) continue; // not an event module — skip
    const expected = stemOf(file, extensions);
    if (actual === null) {
      mismatches.push({ file, expected, actual: null, reason: 'missing-name' });
    } else if (actual !== expected) {
      mismatches.push({ file, expected, actual, reason: 'mismatch' });
    }
  }
  return mismatches;
}

/**
 * Assert every event module's `name` matches its filename. Throws a single error
 * listing all offenders (so one test covers the whole tree). Drop into a test:
 *
 *   import { assertEventNamesMatchFilenames } from 'eventkit/testing';
 *   it('event names match filenames', () =>
 *     assertEventNamesMatchFilenames({ dir: 'functions' }));
 */
export function assertEventNamesMatchFilenames(options: ValidateEventNamesOptions): void {
  const mismatches = findEventNameMismatches(options);
  if (mismatches.length === 0) return;
  const lines = mismatches.map(m =>
    m.reason === 'missing-name'
      ? `  ${m.file}: calls defineEvent() but no string-literal \`name\` was found (expected '${m.expected}')`
      : `  ${m.file}: name '${m.actual}' should be '${m.expected}' to match the filename`,
  );
  throw new Error(
    `${mismatches.length} event module name(s) do not match their filename (ADR-025 one-module-per-file convention):\n${lines.join('\n')}`,
  );
}
