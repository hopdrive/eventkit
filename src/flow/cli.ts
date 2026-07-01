// CLI backend for the `eventkit-flow` bin. Intentionally NOT re-exported from the
// `./flow` barrel — it uses node builtins and is only loaded by the bin, so library
// consumers of `@hopdrive/eventkit/flow` never pull `node:fs` into their bundle.
//
//   eventkit-flow generate --kit <module> [--out <file>] [--export <name>] [--title <s>]
//   eventkit-flow check    --kit <module>  --out <file>  [--export <name>] [--title <s>]
//
// `--kit` points at a module that exports a built EventKit (an object with a
// `describe()` method). The module is imported and introspected — no handler runs.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EventKit } from '../core/index.js';
import { toFlowYaml } from './graph.js';

interface Args {
  command?: string;
  kit?: string;
  out?: string;
  export?: string;
  title?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  if (argv[0] !== undefined) args.command = argv[0];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const take = (): string | undefined => argv[++i];
    const v = a === '--kit' || a === '--out' || a === '-o' || a === '--export' || a === '--title' ? take() : undefined;
    if (v === undefined) continue;
    if (a === '--kit') args.kit = v;
    else if (a === '--out' || a === '-o') args.out = v;
    else if (a === '--export') args.export = v;
    else if (a === '--title') args.title = v;
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

const USAGE = `eventkit-flow — generate a flow document from a built kit

Usage:
  eventkit-flow generate --kit <module> [--out <file>] [--export <name>] [--title <s>]
  eventkit-flow check    --kit <module>  --out <file>  [--export <name>] [--title <s>]

generate  Write (or print) the flow YAML for the kit.
check     Regenerate and compare to <file>; exit 1 if it is missing or stale (CI drift gate).`;

/** Run the CLI. Returns a process exit code; never calls process.exit itself. */
export async function runCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (!args.command || args.command === 'help' || args.command === '--help') {
    process.stdout.write(USAGE + '\n');
    return args.command ? 0 : 1;
  }
  if (args.command !== 'generate' && args.command !== 'check') {
    process.stderr.write(`Unknown command '${args.command}'.\n\n${USAGE}\n`);
    return 1;
  }
  if (!args.kit) {
    process.stderr.write(`Missing --kit <module>.\n\n${USAGE}\n`);
    return 1;
  }

  const kit = await loadKit(args.kit, args.export);
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
