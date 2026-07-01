# @hopdrive/eventkit

Source-agnostic business-event execution framework. It's the successor to
`@hopdrive/hasura-event-detector`. Hasura becomes one *source adapter* among many
(webhooks, cron, and more) instead of the center of the architecture. You name business
events, declare the jobs they run, and the runtime detects them, runs them, observes
them, and (optionally) makes them durable.

> **Status: built, shipping soon.** The runtime detects and runs jobs end to end for
> Hasura DB triggers (`hasuraEvent`), scheduled triggers (`hasuraCron`), vendor webhooks
> (`webhook`), and Hasura Actions (`hasuraAction`), with the built-in plugins, the
> platform adapters, and the request/response capability. Not on npm yet. The design
> record lives in `docs/planning/`. A few items below are marked **planned**, meaning
> specified but not built yet.

---

## Install

```bash
npm install @hopdrive/eventkit
```

> Not published to npm yet (see status above) — the command above is how you'll install it
> once it ships. Until then, consume it via a local file link / workspace.

Dual ESM/CJS, TypeScript types included. Import the **family barrels** —
`@hopdrive/eventkit/sources`, `/platforms`, `/plugins` — for clean, few-line imports;
the package is `sideEffects`-free, so a function only bundles the sources/plugins it
actually names. (Granular subpaths like `/plugins/observability` remain available for the
tightest possible bundle.)

## Quick start

```ts
import { createEventKit, defineEvent, job } from '@hopdrive/eventkit';
import { hasuraEvent } from '@hopdrive/eventkit/sources';
import { netlifyPlatform } from '@hopdrive/eventkit/platforms';
import { observability, graphqlSink } from '@hopdrive/eventkit/plugins';
import { sendOfferSMS, notifyOrg } from './jobs';
import { initSdk } from './lib/sdk';

// 1. An event module is DECLARATIVE: a detector + the jobs that run when it fires.
const appointmentReady = defineEvent({
  name: 'appointment.ready',
  detector: hasuraEvent.detector((ctx) => {
    switch (ctx.operation) {
      case 'INSERT': {
        const insertedReady = ctx.newRow?.status === 'ready';
        return insertedReady;
      }
      case 'UPDATE': {
        const becameReady = ctx.columnChanged('status') && ctx.newRow?.status === 'ready';
        return becameReady;
      }
      default:
        return false;
    }
  }),
  // runs once before the jobs; merged into every job's ctx.input
  prepare: (ctx) => ({ sdk: initSdk(), appointment: ctx.newRow }),
  // a STATIC list, the runtime runs them. no handler body.
  // a bare function IS a job; wrap with job() only to pass options.
  jobs: [sendOfferSMS, job(notifyOrg, { retries: 3 })],
});

// 2. Build the kit ONCE at module scope; register the source (positional) + plugins.
const kit = createEventKit(hasuraEvent)
  .use(netlifyPlatform)
  .use(observability, { sink: graphqlSink({ endpoint: process.env.GQL_URL, adminSecret: process.env.GQL_SECRET }) })
  .registerEvents([appointmentReady]);

// 3. The platform adapter owns the (event, context) signature and the response.
export const handler = kit.handler();
```

A job is a plain function of one context:

```ts
export async function sendOfferSMS(ctx) {
  const { sdk, appointment } = ctx.input;   // shared (from prepare) + per-job input
  ctx.log.info('sending offer SMS', { appointmentId: appointment.id });
  return sdk.sms.send(/* … */);             // return value is recorded as the job output
}
```

## The model

EventKit answers the same three questions for every inbound signal, regardless of source:

| Question | Becomes |
|---|---|
| What came into the system? | a normalized **EventEnvelope** |
| What business event did it represent? | a named **DetectedEvent** (your `detector`) |
| What work ran because of it? | a recorded **JobExecution** per `job` |

Those three answers are the entire runtime data model. Observability, durability, and
flow tooling all build on top of them.

## Event modules (`defineEvent`)

A module is a declarative record. There's no handler function. You declare the jobs and
the runtime runs them.

```ts
defineEvent<TPayload>({
  name,           // business event name (the identity)
  detector,       // (ctx) => boolean. the predicate, keep the switch house style
  prepare?,       // (ctx) => shared. runs once, merges into every job's input
  jobs?,          // a STATIC list of bare functions (or job(fn, opts) when you need options)
  resolve?,       // (ctx) => output. request/response seam (ADR-026), runs concurrent with jobs
  respond?,       // (ctx, { jobs, ok }) => output. result-driven response (ADR-029): runs AFTER
                  //   jobs settle so the reply reflects their outcome. mutually exclusive with resolve
  run?,           // RunOptions for the batch (timeoutMs / metadata). jobs always run parallel;
                  //   mode:'series' + continueOnFailure are a planned future control (ADR-031)
  metadata?,      // registration-time hints for tooling
});  // a module must declare jobs and/or a response seam (resolve or respond)
```

Three rules keep every event chain deterministic and analyzable:

- **No conditional job inclusion.** `jobs` is a static literal, so there's no handler body
  to branch in. A condition either *defines a different event* (put it in a `detector` and
  give it a name) or *means a job has nothing to do* (short-circuit at the top of the job
  on its own `ctx.input`).
- **No fan-out.** The job set is fixed. Data-driven multiplicity goes *inside a job*, or
  via DB writes that trigger further events. Never N emitted jobs.
- **No inter-job dependencies.** Sibling jobs are mutually ignorant of each other's
  existence, result, order, and input. A job behaves the same no matter which siblings
  exist.

`prepare` is where shared, request-scoped references go (an initialized `sdk`, a fetched
row, helper closures). Input merges lowest to highest: plugin baselines, then `prepare`,
then per-job `input`.

## Jobs (`job()`)

A job in the `jobs` array is just a function reference, and the runtime wraps it for you.
You only reach for `job(fn, { ... })` when you need to override a setting for that one job.
Pass the options as the second argument.

```ts
job(fn, {
  retries?,            // in-process retry attempts (durable/delayed retries are Batch')
  timeoutMs?,          // per-job deadline; runtime marks it `timed_out`
  name?,               // stable identity for observability (else fn.name, set it to survive minification)
  tags?,               // labels
  input?,              // live data: an object OR a pure (ctx) => object mapper; merges highest
  metadata?,           // serializable; persisted by Batch, recorded by Observability
});
```

**Jobs always run in parallel with isolated failures** — a failing job never blocks,
cancels, or skips a sibling (ADR-014). This is fixed, not configurable: the `run.mode`
(`'series'`) switch and `continueOnFailure` are a **planned future control, not enabled in
this release** (ADR-031) — series invites the sequential inter-job coupling the declarative
model removes. `run` today carries `timeoutMs` / `metadata`.

> There is **no public `run()`**. The runtime runs the declared `jobs` (ADR-025).

## Sources

A source normalizes an inbound signal and supplies the typed context. **Exactly one per
kit** (the positional arg to `createEventKit`).

- **`hasuraEvent`**. Hasura DB event triggers. Detector context: `operation` (branch on it
  with a `switch`; `case 'MANUAL': return false` suppresses console edits),
  `oldRow`/`newRow`/`row`, `columnChanged()`/`columnAdded()`/`columnRemoved()`,
  `previousValue()`/`currentValue()`.
  Authoring helpers `hasuraEvent.detector<Row>(fn)` / `hasuraEvent.prepare<Row>(fn)`.
- **`hasuraCron`**. Hasura scheduled triggers. Context: `scheduleName`, `scheduledAt`,
  `payload`.
- **`webhook`**. Vendor webhooks (`{ vendor, verify, eventTypeHeader, rejectUnverified? }`).
  The context exposes `signatureVerified`, `vendor`, `eventType`, `body`. `verify` runs once
  (before `normalize`) and annotates `signatureVerified`; the detector decides. Set
  `rejectUnverified: true` (ADR-030) to instead reject a bad signature with 401 before any
  module runs. A status-contract vendor (Stripe) uses `resolve` plus a thrown
  `ClientError(status, ...)`.
- **`hasuraAction`**. A **request/response** source for Hasura Actions
  (`sourceType:'action'`, gated by Hasura's permission model). Context: `actionName`,
  `input`, `sessionVariables`, `requestQuery?`. A module's `resolve` returns the output,
  and the generic platform adapter you register (`netlifyV2Platform`/`netlifyPlatform`/
  `lambdaPlatform`) maps it to 2xx. A thrown `ActionError(message, code?)` maps to 4xx
  `{ message, extensions: { code? } }` (no dedicated action platform). The bespoke `app-*`
  endpoints get *converted* to actions over time (see the migration playbook), not migrated.

## Plugins

Generic and config-driven, registered via `kit.use(plugin, config?)`. I/O plugins take an
**injected transport seam** (`sink` / `store` / `logger` / `send`). They never read
`process.env`. The app passes the config.

| Plugin | Subpath | Registers |
|---|---|---|
| `observability` | `/plugins/observability` | `{ sink, strict? }`. Buffers Invocation→Event→Job, flushes once per invocation |
| `graphqlSink` | `/plugins/observability/graphql-sink` | the built-in observability `sink` (bulk-upsert to Hasura) |
| `batch` | `/plugins/batch` | `{ store, logFlush? }`. Durability. `requires:['source:hasura']` |
| `loopGuard` | `/plugins/loop-guard` | `{ field?, serviceId?, codec? }`. Inbound provenance into `envelope.meta` |
| `grafana` | `/plugins/transports/grafana` | `{ logger }` (bridge to sdk-server-logger) or `{ grafana: { endpoint, auth } }` (direct Loki) |
| `sentry` | `/plugins/transports/sentry` | `{ dsn?, send? }`. Forwards `onError` |

> Durability is **emergent from registering `batch`**. There's no `durable` flag, and
> the job stays batch-unaware. A built-in `graphqlBatchJobStore` is *planned*. Until then,
> provide your own `store.update(id, fields)`. These plugins are generic (ADR-024), so
> there's no separate `@hopdrive/app-eventkit` package. HopDrive just supplies config presets.

## Platform adapters

Map a deployment runtime's invocation, time budget, and response. Register via `kit.use`;
the source stays the positional arg. Use `kit.handler()` (adapter owns the signature) or a
thin `kit.handle(...)`.

- `netlifyPlatform()`. Netlify classic (`{ statusCode, body }`)
- `netlifyV2Platform({ maxExecutionMs? })`. Netlify v2 / Web `Request`→`Response`
- `netlifyBackgroundPlatform({ maxExecutionMs? })`. 15-min background / 202
- `lambdaPlatform()`. AWS Lambda

The `before` hook on `kit.handler({ before })` runs pre-dispatch. Return a
platform-agnostic `{ status, body }` to short-circuit (auth or method) and the adapter's
`formatRejection` shapes it to the runtime's native response.

## Testing

From `@hopdrive/eventkit/testing`:

- `fakeSource(opts?)`. A minimal in-memory source for unit tests.
- `defineFakeEvent(name, detector, jobs, opts?)`. Assemble a module without a real source.
- `buildDetectorContextFor(...)` / `buildHandlerContextFor(...)`. Exercise a detector or job
  against any source's context.

## Flow docs (`@hopdrive/eventkit/flow` + `eventkit-flow`)

Because modules are declarative (a static `jobs` array, no hidden conditional branches),
a kit's whole structure is knowable *without running anything*. `kit.describe()` returns
that snapshot; the `flow` subpath and the `eventkit-flow` CLI turn it into a committed,
diff-friendly YAML document of **how events flow through the system** (source → event →
jobs → declared side effects) — regenerated by a script and kept honest in CI.

```ts
import { toFlowYaml, toFlowGraph, describeKit } from '@hopdrive/eventkit/flow';

toFlowYaml(kit);   // → the human-readable committed doc (see docs/flow.example.yaml)
toFlowGraph(kit);  // → { nodes, edges } in the FlowNode/FlowEdge manifest vocabulary (React Flow / manifest diffing)
describeKit(kit);  // → the raw KitDescription
```

The CLI introspects the kit you export from a module (no handler runs):

```jsonc
// package.json scripts in a consumer repo
{
  "flow:gen":   "eventkit-flow generate --kit ./src/eventkit.js --out architecture/db-rideshares.flow.yaml",
  "flow:check": "eventkit-flow check    --kit ./src/eventkit.js --out architecture/db-rideshares.flow.yaml"
}
```

`generate` writes (or prints) the doc; `check` regenerates and fails if the committed file
is missing or stale — wire it into CI so the doc can never drift from the code. Point
`--kit` at a module that exports an `EventKit` (`export const kit = createEventKit(...)`);
pass `--export <name>` if it isn't the default/`kit` export.

> This is the **generated-structure** half of §14–§16 ("the generator verifies structure").
> The **meaning** half — hand-authored Flow Manifests and Compare Mode — remains phased;
> `toFlowGraph` deliberately emits the same `FlowNode`/`FlowEdge` vocabulary so a generated
> graph can later be diffed against, or promoted into, a manifest.

## Docs

- **Guide.** `docs/guide.html` is the narrative walkthrough (before/after vs.
  `hasura-event-detector`, the plugin model, migration patterns) plus a curated API
  reference. Open it in a browser.
- **Flow example.** `docs/flow.example.yaml` is a generated flow doc (what `eventkit-flow
  generate` emits).
- **API reference (generated).** Run `npm run docs` to build `docs/api/`, the exhaustive,
  every-symbol reference generated from source, so it can't drift.
- **Design record.** The architecture decisions, ADRs, kickoff, decision register, and raw
  planning conversations live in [`docs/planning/`](docs/planning/) (see its `README.md`
  for the read order).

## Develop

```bash
npm install
npm run build                # dual ESM/CJS + .d.ts
npm run typecheck            # strict, no emit
npm run typecheck:contracts  # negative-type fixtures (brand / contribution guards)
npm test                     # vitest
npm run smoke:bundle         # D8 gate: every subpath resolves under esbuild
npm run docs                 # generate docs/api/ via typedoc
```

Open decisions are proceeding on recommended defaults (D19 positional source, D20
qualified capability tokens, D22 lazy plugin instantiation, D6 shadow-mode parity, D7 no
compat facade, D8 single package + subpath exports gated on the bundle smoke test). They're
flagged for ratification in the design record.

## License

UNLICENSED · © HopDrive
