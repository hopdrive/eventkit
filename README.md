# @hopdrive/eventkit

Source-agnostic business-event execution framework — the successor to
`@hopdrive/hasura-event-detector`. Hasura becomes one *source adapter* among many
(webhooks, cron, …) rather than the center of the architecture. You name business
events, declare the jobs they run, and the runtime detects, runs, observes, and
(optionally) makes them durable.

> **Status: in development (Phases 0–5 complete).** The runtime detects and runs jobs
> end-to-end for Hasura DB triggers (`hasuraEvent`) and scheduled triggers
> (`hasuraCron`), with the built-in plugins and platform adapters. Not yet published.
> Design source of truth: `hasura-event-detector/docs/eventkit-rewrite/` (RFC v0.3.9 +
> the kickoff doc, in `docs/planning/`). A few items below are marked **planned** — specified, not yet built.

---

## Install

```bash
npm install @hopdrive/eventkit
```

Dual ESM/CJS, TypeScript types included. Imports are by **subpath**, so a serverless
function only bundles what it uses.

## Quick start

```ts
import { createEventKit, defineEvent, job } from '@hopdrive/eventkit';
import { hasuraEvent } from '@hopdrive/eventkit/sources/hasura';
import { netlifyPlatform } from '@hopdrive/eventkit/platforms';
import { observability } from '@hopdrive/eventkit/plugins/observability';
import { graphqlSink } from '@hopdrive/eventkit/plugins/observability/graphql-sink';
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
  // a STATIC list — the runtime runs them; there is no handler body
  jobs: [job(sendOfferSMS), job(notifyOrg, { retries: 3 })],
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

That answer-set is the entire runtime data model — observability, durability, and flow
tooling all build on it.

## Event modules (`defineEvent`)

A module is a declarative record. **There is no handler function** — you declare the
jobs and the runtime runs them.

```ts
defineEvent<TPayload>({
  name,           // business event name (the identity)
  detector,       // (ctx) => boolean — the predicate; keep the switch house style
  prepare?,       // (ctx) => shared — runs once; result merges into every job's input
  jobs?,          // JobDefinition[] — a STATIC array literal of job(fn, opts?)
  resolve?,       // (ctx) => output — request/response seam (ADR-026); maps to the wire response
  run?,           // RunOptions for the batch (mode / continueOnFailure / timeoutMs)
  metadata?,      // registration-time hints for tooling
});  // a module must declare jobs and/or resolve
```

Three rules keep every event chain deterministic and analyzable:

- **No conditional job inclusion.** `jobs` is a static literal — there's no handler body
  to branch in. A condition either *defines a different event* (put it in a `detector`
  and give it a name) or *means a job has nothing to do* (short-circuit at the top of the
  job on its own `ctx.input`).
- **No fan-out.** The job set is fixed. Data-driven multiplicity goes *inside a job* or via
  DB writes that trigger further events — never N emitted jobs.
- **No inter-job dependencies.** Sibling jobs are mutually ignorant of each other's
  existence, result, order, and input. A job behaves identically regardless of which
  siblings exist.

`prepare` is where shared, request-scoped references go (an initialized `sdk`, a fetched
row, helper closures). Input merge precedence, lowest → highest: **plugin baselines →
`prepare` → per-job `input`**.

## Jobs (`job()`)

```ts
job(fn, {
  retries?,            // in-process retry attempts (durable/delayed retries are BatchJobs')
  timeoutMs?,          // per-job deadline; runtime marks it `timed_out`
  continueOnFailure?,  // per-job override of the run-level default
  name?,               // stable identity for observability (else fn.name — set it to survive minification)
  tags?,               // labels
  input?,              // live data: an object OR a pure (ctx) => object mapper; merges highest
  metadata?,           // serializable; persisted by BatchJobs, recorded by Observability
});
```

`RunOptions` (on the module's `run`) default to **`mode: 'parallel'`,
`continueOnFailure: true`** (pinned — a flaky job never blocks a sibling). Opt into
`mode: 'series'` + `continueOnFailure: false` to stop-and-skip on first failure.

> There is **no public `run()`** — the runtime runs the declared `jobs` (ADR-025).

## Sources

A source normalizes an inbound signal and supplies the typed context. **Exactly one per
kit** (the positional arg to `createEventKit`).

- **`hasuraEvent`** — Hasura DB event triggers. Detector context: `operation`,
  `oldRow`/`newRow`/`row`, `inserted()`/`updated()`/`deleted()`/`manuallyInvoked()`,
  `columnChanged()`/`columnAdded()`/`columnRemoved()`, `previousValue()`/`currentValue()`.
  Authoring helpers `hasuraEvent.detector<Row>(fn)` / `hasuraEvent.prepare<Row>(fn)`.
- **`hasuraCron`** — Hasura scheduled triggers. Context: `scheduleName`, `scheduledAt`,
  `payload`.
- **`webhook`** *(planned)* — vendor webhooks (`{ vendor, verify, eventTypeHeader }`);
  context exposes `signatureVerified`, `vendor`, `eventType`, `body`.
- **`hasuraAction`** *(planned)* — a **request/response** source for Hasura Actions
  (`sourceType:'action'`, gated by Hasura's permission model). Context: `actionName`,
  `input`, `sessionVariables`, `requestQuery?`. A module's `resolve` returns the output;
  `hasuraActionPlatform` maps it → 2xx, and a thrown `ActionError(message, code?)` → 4xx
  `{ message, extensions: { code? } }`. The bespoke `app-*` endpoints are replaced by
  actions over time, not migrated.

## Plugins

Generic and config-driven; registered via `kit.use(plugin, config?)`. I/O plugins take an
**injected transport seam** (`sink` / `store` / `logger` / `send`) — they never read
`process.env`; the app passes config.

| Plugin | Subpath | Registers |
|---|---|---|
| `observability` | `/plugins/observability` | `{ sink, strict? }` — buffers Invocation→Event→Job, flushes once per invocation |
| `graphqlSink` | `/plugins/observability/graphql-sink` | the built-in observability `sink` (bulk-upsert to Hasura) |
| `batchJobs` | `/plugins/batchjobs` | `{ store, logFlush? }` — durability; `requires:['source:hasura']` |
| `loopPrevention` | `/plugins/loop-prevention` | `{ field?, serviceId?, codec? }` — inbound provenance → `envelope.meta` |
| `grafanaLogger` | `/plugins/transports/grafana` | `{ logger }` (bridge to sdk-server-logger) or `{ grafana: { endpoint, auth } }` (direct Loki) |
| `sentry` | `/plugins/transports/sentry` | `{ dsn?, send? }` — forwards `onError` |

> Durability is **emergent from registering `batchJobs`** — there is no `durable` flag; a
> job stays batch-unaware. A built-in `graphqlBatchJobStore` is *planned*; provide your own
> `store.update(id, fields)` meanwhile. These plugins are generic (ADR-024) — there is no
> separate `@hopdrive/app-eventkit` package; HopDrive supplies config presets.

## Platform adapters

Map a deployment runtime's invocation, time budget, and response. Register via `kit.use`;
the source stays the positional arg. Use `kit.handler()` (adapter owns the signature) or a
thin `kit.handle(...)`.

- `netlifyPlatform()` — Netlify classic (`{ statusCode, body }`)
- `netlifyV2Platform({ maxExecutionMs? })` — Netlify v2 / Web `Request`→`Response`
- `netlifyBackgroundPlatform({ maxExecutionMs? })` — 15-min background / 202
- `lambdaPlatform()` — AWS Lambda

The `before` hook on `kit.handler({ before })` runs pre-dispatch; return a
platform-agnostic `{ status, body }` to short-circuit (auth / method) and the adapter's
`formatRejection` shapes it to the runtime's native response.

## Testing

From `@hopdrive/eventkit/testing`:

- `fakeSource(opts?)` — minimal in-memory source for unit tests
- `defineFakeEvent(name, detector, jobs, opts?)` — assemble a module without a real source
- `buildDetectorContextFor(...)` / `buildHandlerContextFor(...)` — exercise a detector/job
  against any source's context

## Docs

- **Guide** — `docs/guide.html`: the narrative walkthrough (before/after vs.
  `hasura-event-detector`, the plugin model, migration patterns) plus a curated API
  reference. Open it in a browser.
- **API reference (generated)** — `npm run docs` → `docs/api/`: the exhaustive,
  every-symbol reference generated from source, so it can't drift.
- **Design** — the RFC, ADRs, kickoff, decision register, and raw planning conversations
  in [`docs/planning/`](docs/planning/) (see its `README.md` for the read order).

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
compat facade, D8 single package + subpath exports gated on the bundle smoke test) —
flagged for ratification in the RFC.

## License

UNLICENSED · © HopDrive
