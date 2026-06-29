// Netlify-bundle smoke test (D8 / §17).
//
// Deep `exports`-map subpaths are a known "works locally, module-not-found at
// deploy" risk under Netlify's esbuild/zisi packager. This is the release GATE
// that catches it: build the package, then bundle a synthetic Netlify function
// that imports EVERY subpath with esbuild (the same bundler zisi uses) for a
// node target, and assert each import resolves in the packaged output. If this
// proves unreliable, the fallback is a package family (D8).
//
// Run AFTER `npm run build`.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Every subpath declared in package.json `exports` (except the root, imported by name).
const SUBPATHS = [
  '@hopdrive/eventkit',
  '@hopdrive/eventkit/core',
  '@hopdrive/eventkit/sources/hasura',
  '@hopdrive/eventkit/sources/webhook',
  '@hopdrive/eventkit/plugins/batchjobs',
  '@hopdrive/eventkit/plugins/observability',
  '@hopdrive/eventkit/plugins/observability/graphql-sink',
  '@hopdrive/eventkit/plugins/loop-prevention',
  '@hopdrive/eventkit/plugins/transports/grafana',
  '@hopdrive/eventkit/plugins/transports/sentry',
  '@hopdrive/eventkit/platforms',
  '@hopdrive/eventkit/testing',
];

function assertBuilt() {
  if (!fs.existsSync(path.join(ROOT, 'dist'))) {
    console.error('dist/ not found — run `npm run build` first.');
    process.exit(1);
  }
}

// Build a sandbox that resolves "@hopdrive/eventkit" to this package via a
// node_modules symlink, so esbuild resolves exactly as a consumer would.
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventkit-smoke-'));
  const scope = path.join(dir, 'node_modules', '@hopdrive');
  fs.mkdirSync(scope, { recursive: true });
  fs.symlinkSync(ROOT, path.join(scope, 'eventkit'), 'dir');
  return dir;
}

function writeEntry(dir, format) {
  const ext = format === 'cjs' ? 'cjs' : 'mjs';
  const lines =
    format === 'cjs'
      ? SUBPATHS.map((p, i) => `const m${i} = require(${JSON.stringify(p)}); used.push(typeof m${i});`)
      : SUBPATHS.map((p, i) => `import * as m${i} from ${JSON.stringify(p)}; used.push(typeof m${i});`);
  const body = `const used = [];\n${lines.join('\n')}\nexport const handler = async () => ({ statusCode: 200, body: JSON.stringify(used) });\n`;
  const cjsBody = `const used = [];\n${lines.join('\n')}\nexports.handler = async () => ({ statusCode: 200, body: JSON.stringify(used) });\n`;
  const file = path.join(dir, `fn.${ext}`);
  fs.writeFileSync(file, format === 'cjs' ? cjsBody : body);
  return file;
}

function bundle(entry, sandbox, format) {
  const out = path.join(sandbox, `bundle.${format}.js`);
  // Mirror zisi: esbuild, platform=node, bundle everything.
  execFileSync(
    path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
    [
      entry,
      '--bundle',
      '--platform=node',
      `--format=${format === 'cjs' ? 'cjs' : 'esm'}`,
      '--target=node18',
      `--outfile=${out}`,
    ],
    { cwd: sandbox, stdio: 'pipe' },
  );
  return out;
}

function main() {
  assertBuilt();
  const sandbox = makeSandbox();
  let failures = 0;

  for (const format of ['esm', 'cjs']) {
    try {
      const entry = writeEntry(sandbox, format);
      bundle(entry, sandbox, format);
      console.log(`✓ ${format.toUpperCase()} bundle resolved all ${SUBPATHS.length} subpaths`);
    } catch (err) {
      failures++;
      console.error(`✗ ${format.toUpperCase()} bundle failed:\n${err.stderr?.toString() || err.message}`);
    }
  }

  fs.rmSync(sandbox, { recursive: true, force: true });
  if (failures > 0) {
    console.error('\nBundle smoke test FAILED — subpath exports do not resolve under esbuild.');
    process.exit(1);
  }
  console.log('\nBundle smoke test passed.');
}

main();
