// CLI backend for the `eventkit-flow` bin. Intentionally NOT re-exported from the
// `./flow` barrel — it uses node builtins and is only loaded by the bin, so library
// consumers of `@hopdrive/eventkit/flow` never pull `node:fs` into their bundle.
//
//   eventkit-flow generate --kit <module> [--out <file>] [--export <name>] [--title <s>]
//   eventkit-flow check    --kit <module>  --out <file>  [--export <name>] [--title <s>]
//
// `--kit` points at a module that exports a built EventKit (an object with a
// `describe()` method). The module is imported and introspected — no handler runs.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EventKit } from '../core/index.js';
import { toFlowYaml } from './graph.js';

interface Args {
  command?: string;
  kit?: string;
  out?: string;
  export?: string;
  title?: string;
  tests?: string;
  payload?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  if (argv[0] !== undefined) args.command = argv[0];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const take = (): string | undefined => argv[++i];
    const flags = ['--kit', '--out', '-o', '--export', '--title', '--tests', '--payload'];
    const v = flags.includes(a as string) ? take() : undefined;
    if (v === undefined) continue;
    if (a === '--kit') args.kit = v;
    else if (a === '--out' || a === '-o') args.out = v;
    else if (a === '--export') args.export = v;
    else if (a === '--title') args.title = v;
    else if (a === '--tests') args.tests = v;
    else if (a === '--payload') args.payload = v;
  }
  return args;
}

const isKit = (v: unknown): v is EventKit =>
  !!v && typeof (v as { describe?: unknown }).describe === 'function';

/** Load the caller's module and pick the EventKit export (--export → default → kit → first match). */
async function loadKit(kitPath: string, exportName?: string): Promise<EventKit> {
  const abs = resolve(process.cwd(), kitPath);
  if (!existsSync(abs)) throw new Error(`--kit module not found: ${abs}`);
  const mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;

  if (exportName) {
    const picked = mod[exportName];
    if (!isKit(picked)) throw new Error(`Export '${exportName}' in ${kitPath} is not an EventKit (no describe()).`);
    return picked;
  }
  const candidates = [mod['default'], mod['kit'], ...Object.values(mod)];
  const found = candidates.find(isKit);
  if (!found) {
    throw new Error(
      `No EventKit export found in ${kitPath}. Export your kit (e.g. \`export const kit = createEventKit(...)\`) ` +
        `or pass --export <name>.`,
    );
  }
  return found;
}

function writeOut(outPath: string, yaml: string): void {
  const abs = resolve(process.cwd(), outPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, yaml, 'utf8');
}

const USAGE = `eventkit-flow — flow tooling for a built kit

Usage:
  eventkit-flow generate --kit <module> [--out <file>] [--export <name>] [--title <s>]
  eventkit-flow check    --kit <module>  --out <file>  [--export <name>] [--title <s>]
  eventkit-flow coverage --kit <module> [--tests <dir>] [--export <name>]
  eventkit-flow simulate --kit <module>  --payload <fixture.json> [--export <name>]

generate  Write (or print) the flow YAML for the kit.
check     Regenerate and compare to <file>; exit 1 if it is missing or stale (CI drift gate).
coverage  Fail if any registered event lacks a detector-contract test (CI gate).
simulate  Run the kit's detectors against a fixture payload; print would-fire events/jobs.`;

/** Recursively collect test-file paths under a dir (skips node_modules/dist/.git). */
function findTestFiles(dir: string): string[] {
  const out: string[] = [];
  const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage', '.next']);
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (!SKIP.has(name)) walk(full);
      } else if (/\.(test|spec|contract)\.[cm]?[jt]sx?$/.test(name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/** An event is "covered" if some test file names it AND calls detectorContract. */
async function runCoverage(kit: EventKit, testsDir: string): Promise<{ uncovered: string[]; scanned: number }> {
  const events = kit.describe().events.map(e => e.name);
  const files = findTestFiles(resolve(process.cwd(), testsDir));
  const contents = files.map(f => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  });
  const uncovered = events.filter(
    name => !contents.some(c => c.includes('detectorContract') && (c.includes(`'${name}'`) || c.includes(`"${name}"`) || c.includes('`' + name + '`'))),
  );
  return { uncovered, scanned: files.length };
}

/** Run the CLI. Returns a process exit code; never calls process.exit itself. */
export async function runCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (!args.command || args.command === 'help' || args.command === '--help') {
    process.stdout.write(USAGE + '\n');
    return args.command ? 0 : 1;
  }
  const known = ['generate', 'check', 'coverage', 'simulate'];
  if (!known.includes(args.command)) {
    process.stderr.write(`Unknown command '${args.command}'.\n\n${USAGE}\n`);
    return 1;
  }
  if (!args.kit) {
    process.stderr.write(`Missing --kit <module>.\n\n${USAGE}\n`);
    return 1;
  }

  const kit = await loadKit(args.kit, args.export);

  // coverage: every registered event must have a detector-contract test (CI gate).
  if (args.command === 'coverage') {
    const { uncovered, scanned } = await runCoverage(kit, args.tests ?? '.');
    if (uncovered.length) {
      process.stderr.write(
        `✗ ${uncovered.length} event(s) lack a detector-contract test (scanned ${scanned} test file(s)):\n` +
          uncovered.map(n => `    - ${n}`).join('\n') +
          `\n  Add a test that calls detectorContract(...) and names the event.\n`,
      );
      return 1;
    }
    process.stdout.write(`✓ every registered event has a detector-contract test (scanned ${scanned} test file(s))\n`);
    return 0;
  }

  // simulate: run detectors against a fixture and print would-fire events/jobs.
  if (args.command === 'simulate') {
    if (!args.payload) {
      process.stderr.write(`simulate requires --payload <fixture.json>.\n`);
      return 1;
    }
    const abs = resolve(process.cwd(), args.payload);
    if (!existsSync(abs)) {
      process.stderr.write(`✗ payload fixture not found: ${abs}\n`);
      return 1;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (err) {
      process.stderr.write(`✗ could not parse ${args.payload} as JSON: ${(err as Error).message}\n`);
      return 1;
    }
    const dry = await kit.dryRun(payload);
    const fired = dry.events.filter(e => e.detected);
    if (!fired.length) {
      process.stdout.write(`No events would fire for ${args.payload}.\n`);
    } else {
      process.stdout.write(`Would fire ${fired.length} event(s) for ${args.payload}:\n`);
      for (const e of fired) {
        process.stdout.write(`  ⭐ ${e.name}${e.jobs.length ? ` → jobs: ${e.jobs.join(', ')}` : ''}\n`);
      }
    }
    const errored = dry.events.filter(e => e.error);
    for (const e of errored) process.stderr.write(`  ✗ ${e.name} detector threw: ${e.error}\n`);
    return 0;
  }

  const yaml = toFlowYaml(kit, args.title ? { title: args.title } : {});

  if (args.command === 'generate') {
    if (args.out) {
      writeOut(args.out, yaml);
      process.stdout.write(`✓ wrote ${args.out}\n`);
    } else {
      process.stdout.write(yaml);
    }
    return 0;
  }

  // check
  if (!args.out) {
    process.stderr.write(`check requires --out <file> to compare against.\n`);
    return 1;
  }
  const abs = resolve(process.cwd(), args.out);
  if (!existsSync(abs)) {
    process.stderr.write(`✗ ${args.out} does not exist — run \`eventkit-flow generate\` and commit it.\n`);
    return 1;
  }
  const current = readFileSync(abs, 'utf8');
  if (current !== yaml) {
    process.stderr.write(
      `✗ ${args.out} is out of date with the registered events.\n` +
        `  Run \`eventkit-flow generate --kit ${args.kit} --out ${args.out}\` and commit the result.\n`,
    );
    return 1;
  }
  process.stdout.write(`✓ ${args.out} is up to date\n`);
  return 0;
}
