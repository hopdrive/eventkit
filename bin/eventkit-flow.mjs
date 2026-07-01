#!/usr/bin/env node
// Thin bin shim: delegate to the built ESM CLI backend. Kept tiny so all logic
// stays in TypeScript (src/flow/cli.ts) and is typechecked + testable.
import { runCli } from '../dist/esm/flow/cli.js';

runCli(process.argv.slice(2))
  .then(code => {
    process.exitCode = code;
  })
  .catch(err => {
    process.stderr.write(`eventkit-flow: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
