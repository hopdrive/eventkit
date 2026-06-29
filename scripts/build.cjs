// Dual ESM + CJS build for @hopdrive/eventkit.
//
// Strategy (deliberately matching the proven @hopdrive/hasura-event-detector setup,
// minus tsc-alias): source files use explicit `.js`-extension relative imports, so
// `tsc` emits import specifiers verbatim for both module systems and no path-rewrite
// step is needed. We drop a `package.json` type marker in each output dir so Node
// resolves dist/esm/*.js as ESM and dist/cjs/*.js as CommonJS.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function run(cmd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

function build() {
  run('npm run clean');

  console.log('Compiling ESM...');
  run('npm run build:esm');

  console.log('Compiling CJS...');
  run('npm run build:cjs');

  console.log('Emitting declarations...');
  run('npm run build:types');

  console.log('Writing module-type marker files...');
  const root = path.join(__dirname, '..');
  fs.writeFileSync(path.join(root, 'dist/esm/package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'dist/cjs/package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');

  console.log('Build complete.');
}

if (require.main === module) {
  try {
    build();
  } catch (err) {
    console.error(`Build failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { build };
