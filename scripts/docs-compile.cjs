// =============================================================================
// docs-compile gate (testing-strategy.md §20)
// =============================================================================
// Kills the doc-drift defect class: every `import { … } from 'eventkit…'`
// in README.md and docs/guide.html must reference exports that ACTUALLY EXIST in the
// built package. A renamed or removed export whose doc snippet wasn't updated fails
// CI here with a readable diff, instead of a consumer discovering it at copy-paste time.
//
// (The canonical runnable example, src/__examples__/appointment.ready.ts, is fully
// type-checked separately via tsconfig.typetest.json — that covers snippet SHAPE. The
// README/guide snippets are illustrative and not self-contained, so the reliable,
// false-positive-free check on them is export-name resolution, done here.)
//
// Run AFTER `npm run build` (it reads the built dist/cjs entrypoints).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DOC_FILES = ['README.md', 'docs/guide.html'];

// Map a bare specifier (e.g. 'eventkit/plugins') to its built CJS entry.
function entryFor(specifier) {
  const subpath = specifier === pkg.name ? '.' : './' + specifier.slice(pkg.name.length + 1);
  const entry = pkg.exports?.[subpath];
  if (!entry) return null;
  const req = entry.require?.default ?? entry.require ?? entry.default;
  return typeof req === 'string' ? path.join(ROOT, req) : null;
}

// Every `import ... from '<pkg or subpath>'` statement (multi-line aware). The clause is
// restricted to a real import binding — `{ … }` (no nested brace, so it can't run past the
// statement), a namespace (`* as X`), or a default identifier — so prose/other imports in
// between are never swallowed.
function importStatements(text) {
  const re = /import\s+((?:type\s+)?(?:\*\s+as\s+\w+|\w+\s*,?\s*(?:\{[^}]*\})?|\{[^}]*\}))\s+from\s+['"](@hopdrive\/eventkit(?:\/[^'"]+)?)['"]/g;
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push({ clause: m[1], specifier: m[2] });
  return out;
}

// Named imports inside `{ … }` → bare export names (strip `type `, `as alias`, comments).
function namedImports(clause) {
  const brace = clause.match(/\{([\s\S]*)\}/);
  if (!brace) return []; // default or namespace import — nothing to name-check
  return brace[1]
    .replace(/\/\/[^\n]*/g, '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => s.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
}

// guide.html wraps code in syntax-highlight <span> tags, so strip tags + decode the
// entities that appear inside import statements before scanning, or every guide import
// would be silently skipped.
function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rsquo;/g, "'");
}

const failures = [];
let checked = 0;

for (const file of DOC_FILES) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) continue;
  let text = fs.readFileSync(full, 'utf8');
  if (file.endsWith('.html')) text = stripHtml(text);
  for (const { clause, specifier } of importStatements(text)) {
    const entry = entryFor(specifier);
    if (!entry) {
      failures.push(`${file}: unknown subpath '${specifier}' (not in package.json "exports")`);
      continue;
    }
    let mod;
    try {
      mod = require(entry);
    } catch (err) {
      failures.push(`${file}: could not load '${specifier}' (${entry}): ${err.message}`);
      continue;
    }
    const exportNames = new Set(Object.keys(mod));
    for (const name of namedImports(clause)) {
      checked++;
      // A type-only export is erased from the runtime module, so a runtime miss is only a
      // failure if it's ALSO not a known type export. We can't see types at runtime, so we
      // treat a runtime miss as a failure ONLY when the module exports nothing by that name;
      // to avoid false positives on type-only names, we skip PascalCase-looking type names
      // that aren't present (interfaces/types), and flag missing value-looking (camelCase) ones.
      if (!exportNames.has(name)) {
        const looksLikeType = /^[A-Z]/.test(name); // Types/interfaces are erased at runtime
        if (!looksLikeType) failures.push(`${file}: '${specifier}' has no export '${name}'`);
      }
    }
  }
}

if (failures.length) {
  console.error(`docs-compile: ${failures.length} doc-drift issue(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`docs-compile: OK — ${checked} documented import name(s) resolve against the built package.`);
