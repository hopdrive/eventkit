# Event Handling Framework Redesign

- **Source:** https://chatgpt.com/g/g-p-6a35712f5bf48191b053ab0cf5a46ba4/c/6a30d9d3-e724-832f-ae43-55e3766688dd
- **Messages:** 46
- **Exported:** ChatGPT backend-api (full thread, with timestamps)

---

## [1] User — 2026-06-16 05:06:51 UTC

Use the GitHub app to read the Hasura event detector package repo and how it’s used in event handlers repo. 

I am considering a rewrite of the Hasura event detector so it’s not built around Hasura only. But instead I want it to be an event handling and async job registration framework like it is but Hasura event types would just be the first of many plugins with support for event payload setups like any webhook from any vendor for instance. A framework for defining those things easily with ts so we could expand the abstraction of the package beyond Hasura. It’s mostly there already with cron, app, and db event types but that should all be rethought. 

We also added the observability plugin system a while back too and that has a console too that we deployed to a site. We should rethink the structure of the Hasura event detector repo to better organize the observable plugin and the console website for it.

Also the batchjobs system was built on top of the event handlers site and thus on top of the Hasura event detector system. We use batch jobs to add exception trapping and state management for the batchjobs in the associated tables. This might become a plugin instead in this new version? Let’s brainstorm. 

Let’s also rename this package. 

The reverse integration sites in the repos for HopDrive also make use of the events pattern from the event handlers site. Where an event is defined in a named module then loaded using a class loader style setup so the events are referred to by name and invoked as handlers for equivalent inbound webhooks.

---

## [2] Assistant (gpt-5-5-thinking) — 2026-06-16 05:06:56 UTC

I’ll inspect the relevant repos first, then map the current architecture and usage patterns before proposing a generalized framework, plugin model, repo structure, and naming directions.

---

## [3] Assistant (gpt-5-5-thinking) — 2026-06-16 05:07:15 UTC

I found the two core repos: `hopdrive/hasura-event-detector` and `hopdrive/event-handlers`. I’m going to sample their package structure, exported APIs, handler definitions, observability pieces, and batch job usage rather than attempting a full line-by-line audit.

---

## [4] Assistant (gpt-5-5-thinking) — 2026-06-16 05:09:04 UTC

I read the core repos and agree: this wants to become a general **event intake, detection, handling, jobs, and observability framework**, with Hasura as one adapter, not the identity of the package.

Current shape:
- `hasura-event-detector` already describes detector, handler, and job separation, plus observability around detected events, job runs, durations, and dependencies. fileciteturn7file1
- `event-handlers` uses it through static event module indexes and `listenTo(...)`, registering observability, tracking-token, and Grafana plugins per function. fileciteturn10file0
- Individual events are already named modules with a detector and handler, for example `move.pickedup`. fileciteturn11file0
- The current type system is still Hasura-centered: `HasuraEventPayload`, `parseHasuraEvent`, `DetectorFunction(event, hasuraEvent)`, etc. fileciteturn21file0
- The console is already its own package, but still named `@hopdrive/hasura-event-detector-console`. fileciteturn27file0

My recommendation: rename and restructure around **event runtime core + source adapters + execution plugins**.

Best package name candidates:
1. **`@hopdrive/eventforge`**: best product-y name; implies defining event systems.
2. **`@hopdrive/eventkit`**: clean, practical, TS framework feel.
3. **`@hopdrive/eventflow`**: good, but slightly generic.
4. **`@hopdrive/async-events`**: clear, less brandable.
5. **`@hopdrive/event-runtime`**: most accurate, least cute.

I’d pick **EventKit** for the package family:

```txt
@hopdrive/eventkit
@hopdrive/eventkit-hasura
@hopdrive/eventkit-observability
@hopdrive/eventkit-console
@hopdrive/eventkit-batchjobs
@hopdrive/eventkit-netlify
```

Proposed conceptual model:

```ts
const runtime = createEventRuntime({
  source: hasuraSource(),
  registry: events,
  plugins: [
    observabilityPlugin(...),
    trackingTokenPlugin(...),
    grafanaLoggerPlugin(...),
    batchJobsPlugin(...),
  ],
});

await runtime.handle(rawPayload, requestContext);
```

Event module shape:

```ts
export default defineEvent({
  name: 'move.pickedup',
  source: 'hasura',
  match: hasura.update('moves').whenColumnChanged('status').to('pickedUp'),
  jobs: [
    job(changeParentDriveStatus),
  ],
});
```

For non-Hasura webhooks:

```ts
export default defineEvent({
  name: 'sparkserv.order.created',
  source: 'webhook.sparkserv',
  schema: SparkOrderCreatedSchema,
  match: payload => payload.type === 'order.created',
  jobs: [
    job(createMoveFromSparkOrder),
  ],
});
```

Repo structure I’d aim for:

```txt
packages/
  core/                 # runtime, registry, defineEvent, job/run, plugin lifecycle
  source-hasura/         # Hasura payload parser, db helpers, columnHasChanged
  source-webhook/        # generic webhook source, signature verification hooks
  plugin-observability/  # current ObservabilityPlugin, transports, schema
  plugin-batchjobs/      # exception trapping, state machine, DB-backed job records
  plugin-tracking-token/
  console/               # React/Vite console app
  netlify-adapter/        # event handler wrappers, auth, response helpers
examples/
  hasura-netlify/
  webhook-vendor/
  batchjobs/
docs/
  architecture/
  migration/
```

The key refactor is to replace `HasuraEventPayload` as the runtime primitive with something like:

```ts
type EventEnvelope<TPayload = unknown, TMeta = unknown> = {
  id: string;
  source: string;
  type?: string;
  payload: TPayload;
  meta: TMeta;
  receivedAt: string;
  correlationId: string;
  raw?: unknown;
};
```

Then Hasura becomes an adapter that maps Hasura payloads into an envelope and exposes Hasura-specific helpers:

```ts
const { dbEvent, operation } = hasura.from(envelope);
hasura.columnHasChanged('status', envelope);
```

Batchjobs should become a plugin, but probably not only a plugin. I’d split it:
- **Core job runtime**: run jobs, retries, timeout, result collection.
- **Batchjobs plugin**: persists job state, traps exceptions, marks started/completed/failed, links records to event invocation/job execution IDs.
- **Batchjobs source adapter**: optional Hasura-backed trigger for `batchjobs` table inserts.

That keeps batch jobs usable from Hasura, cron, app handlers, or third-party webhook events.

Migration strategy:
1. Introduce `@hopdrive/eventkit` core while keeping `hasura-event-detector` as a compatibility facade.
2. Move Hasura-only types/helpers into `@hopdrive/eventkit-hasura`.
3. Convert `listenTo(hasuraEvent)` into `runtime.handle(hasuraEvent)` with `hasuraSource()`.
4. Keep existing event modules working with a shim.
5. Move console and observability into first-class packages and rename them.
6. Promote the reverse-integration pattern into `source-webhook` plus `defineWebhookEvent(...)`.

Big design principle: **source adapters normalize inbound payloads; event modules name business facts; plugins observe/augment execution; jobs perform side effects.**

---

## [5] User — 2026-06-16 13:49:27 UTC

Event Framework Rewrite - Architectural Decisions

Core Direction

The current Hasura Event Detector should evolve into a general event detection, event handling, async job, and observability framework.

Hasura becomes the first source adapter, not the central abstraction of the framework.

The framework should support:

* Hasura database events
* Generic webhook events
* Cron/scheduled events
* Application-generated events
* Batch job events
* Future event sources

while preserving the event authoring experience that exists today in event-handlers.

⸻

Event Modules Remain the Center of the System

The existing event module pattern is a major strength and should be preserved.

Events continue to be defined as individual modules named after the business event:

move.pickup.started
move.pickup.arrived
move.delivery.started
acertus.order.created

Each module exports:

export const detector = ...
export const handler = ...

The detector remains at the top of the file and should be the first thing developers see when opening the module.

⸻

Detector Readability is a Primary Design Goal

Detector code should read like a logical sentence.

Complex criteria should be assigned to well-named variables.

The final return statement should clearly express the business logic.

Example:

const pickupStartedChanged =
  columnChanged('pickup_started');
const pickupStartedWasSet =
  newRow.pickup_started !== null;
const pickupStartedTimestampIsValid =
  isStatusTimeChangeValid(
    newRow.pickup_started,
    oldRow.pickup_started,
  );
return (
  pickupStartedChanged &&
  pickupStartedWasSet &&
  pickupStartedTimestampIsValid
);

The framework should optimize for readability first.

⸻

Detector Plugins Provide Context and Utilities

Detector plugins are responsible for exposing source-specific context and helper functions.

Example:

export const detector = hasura.detector((ctx) => {
  ...
});

The Hasura plugin may provide:

operation
table
oldRow
newRow
columnChanged()
columnAdded()
columnRemoved()

and other Hasura-specific helpers.

The core framework should not know about Hasura concepts.

⸻

Domain Logic Does Not Belong in Source Plugins

Source plugins should only expose source-level concepts.

Bad:

Hasura plugin contains move-specific helpers
Hasura plugin contains HopDrive business rules

Good:

Hasura plugin contains columnChanged()
Hasura plugin contains row access helpers
Hasura plugin contains operation helpers

Move-specific helpers belong in HopDrive application code.

Example:

event-handlers/
  lib/
    move-detector-helpers/

not inside the framework.

⸻

Business Events Are Independent From Event Sources

The event name represents a business event.

The detector source is implementation detail.

Example:

move.pickup.started

is the business event.

Detection may come from:

hasura.detector(...)

or

webhook.detector(...)

or

batchJob.detector(...)

without changing the event identity.

This separation is a key architectural goal.

⸻

Batch Jobs Should Become a First-Class Plugin

Current batch jobs are built on top of the event framework.

The next version should treat batch jobs as a plugin rather than a special subsystem.

Responsibilities:

* execution tracking
* retries
* exception trapping
* state persistence
* lifecycle events
* observability integration

The framework should provide generic job execution primitives while the batch job plugin handles persistence and state management.

⸻

Observability and Console

Observability should be promoted to a first-class package.

The console should be organized alongside observability rather than feeling attached to Hasura.

Potential package structure:

eventkit/
eventkit-source-hasura/
eventkit-source-webhook/
eventkit-plugin-observability/
eventkit-plugin-batchjobs/
eventkit-console/

⸻

Guiding Principle

Source adapters normalize incoming events.

Event modules define business events.

Handlers execute business behavior.

Plugins augment execution (observability, tracking, retries, state management, etc.).

The event module remains the primary authoring experience and the most important abstraction in the system.

---

## [6] Assistant (gpt-5-5-thinking) — 2026-06-16 13:49:29 UTC

This is a strong direction. I’d lock this in as the rewrite’s architecture spine.

The one refinement I’d add:

**Rename “detector plugins” to “source adapters” or “source contexts.”**  
“Plugin” should mean execution augmentation: observability, batchjobs, tracking, logging, retries.  
“Source adapter” should mean payload normalization plus detector authoring helpers.

So:

```ts
export const detector = hasura.detector((ctx)

---

## [7] User — 2026-06-16 13:49:41 UTC

Event Framework Rewrite - Architectural Decisions

Core Direction

The current Hasura Event Detector should evolve into a general event detection, event handling, async job, and observability framework.

Hasura becomes the first source adapter, not the central abstraction of the framework.

The framework should support:

* Hasura database events
* Generic webhook events
* Cron/scheduled events
* Application-generated events
* Batch job events
* Future event sources

while preserving the event authoring experience that exists today in event-handlers.

⸻

Event Modules Remain the Center of the System

The existing event module pattern is a major strength and should be preserved.

Events continue to be defined as individual modules named after the business event:

move.pickup.started
move.pickup.arrived
move.delivery.started
acertus.order.created

Each module exports:

export const detector = ...
export const handler = ...

The detector remains at the top of the file and should be the first thing developers see when opening the module.

⸻

Detector Readability is a Primary Design Goal

Detector code should read like a logical sentence.

Complex criteria should be assigned to well-named variables.

The final return statement should clearly express the business logic.

Example:

const pickupStartedChanged =
  columnChanged('pickup_started');
const pickupStartedWasSet =
  newRow.pickup_started !== null;
const pickupStartedTimestampIsValid =
  isStatusTimeChangeValid(
    newRow.pickup_started,
    oldRow.pickup_started,
  );
return (
  pickupStartedChanged &&
  pickupStartedWasSet &&
  pickupStartedTimestampIsValid
);

The framework should optimize for readability first.

⸻

Detector Plugins Provide Context and Utilities

Detector plugins are responsible for exposing source-specific context and helper functions.

Example:

export const detector = hasura.detector((ctx) => {
  ...
});

The Hasura plugin may provide:

operation
table
oldRow
newRow
columnChanged()
columnAdded()
columnRemoved()

and other Hasura-specific helpers.

The core framework should not know about Hasura concepts.

⸻

Domain Logic Does Not Belong in Source Plugins

Source plugins should only expose source-level concepts.

Bad:

Hasura plugin contains move-specific helpers
Hasura plugin contains HopDrive business rules

Good:

Hasura plugin contains columnChanged()
Hasura plugin contains row access helpers
Hasura plugin contains operation helpers

Move-specific helpers belong in HopDrive application code.

Example:

event-handlers/
  lib/
    move-detector-helpers/

not inside the framework.

⸻

Business Events Are Independent From Event Sources

The event name represents a business event.

The detector source is implementation detail.

Example:

move.pickup.started

is the business event.

Detection may come from:

hasura.detector(...)

or

webhook.detector(...)

or

batchJob.detector(...)

without changing the event identity.

This separation is a key architectural goal.

⸻

Batch Jobs Should Become a First-Class Plugin

Current batch jobs are built on top of the event framework.

The next version should treat batch jobs as a plugin rather than a special subsystem.

Responsibilities:

* execution tracking
* retries
* exception trapping
* state persistence
* lifecycle events
* observability integration

The framework should provide generic job execution primitives while the batch job plugin handles persistence and state management.

⸻

Observability and Console

Observability should be promoted to a first-class package.

The console should be organized alongside observability rather than feeling attached to Hasura.

Potential package structure:

eventkit/
eventkit-source-hasura/
eventkit-source-webhook/
eventkit-plugin-observability/
eventkit-plugin-batchjobs/
eventkit-console/

⸻

Guiding Principle

Source adapters normalize incoming events.

Event modules define business events.

Handlers execute business behavior.

Plugins augment execution (observability, tracking, retries, state management, etc.).

The event module remains the primary authoring experience and the most important abstraction in the system.

---

## [8] Assistant (gpt-5-5-thinking) — 2026-06-16 13:49:44 UTC

This is the right direction. I’d lock this in as the architectural north star.

The key decision is:

**Event identity belongs to the business. Event source belongs to the detector.**

So this stays valid:

```ts
// events/move.pickup.started.ts

export const detector = hasura.detector((ctx) => {
  const pickupStartedChanged = ctx.columnChanged('pickup_started');
  const pickupStartedWasSet = ctx.newRow.pickup_started !== null;

  return pickupStartedChanged && pickupStartedWasSet;
});

export const handler = async (event, ctx) => {
  return run(event, [
    job(updateMoveTimeline),
    job(notifyDealer),
  ]);
};
```

But later this could also be valid:

```ts
export const detector = webhook.detector((ctx) => {
  return ctx.vendor === 'acertus' && ctx.eventType === 'pickup.started';
});
```

Same business event. Different source.

I’d define the package boundaries like this:

```txt
eventkit
  Core runtime
  Event registry
  Module loading
  Job primitives
  Plugin lifecycle

eventkit-source-hasura
  Hasura payload normalization
  Hasura detector context
  columnChanged, oldRow, newRow, operation, table

eventkit-source-webhook
  Generic webhook normalization
  Signature verification hooks
  Vendor payload adapters

eventkit-plugin-observability
  Invocation/event/job lifecycle capture
  GraphQL/SQL transports
  Tracking IDs

eventkit-plugin-batchjobs
  Persistent job state
  Retries
  Exception trapping
  Batch/job lifecycle records

eventkit-console
  Observability UI
  Job/event explorer
  Debug console
```

One naming thought: **EventKit** still feels like the best fit. It communicates framework/toolkit without overcommitting to Hasura, jobs, or observability specifically.

The next artifact I’d create is a short `ARCHITECTURE.md` for the repo with these decisions, then a migration plan from `@hopdrive/hasura-event-detector` to `@hopdrive/eventkit`.

---

## [9] User — 2026-06-16 13:50:30 UTC

Yes let’s start with the architecture

---

## [10] Assistant (gpt-5-5-thinking) — 2026-06-16 13:50:32 UTC

Here’s a first-pass `ARCHITECTURE.md` draft.

:::writing{variant="document" id="47291"}
# EventKit Architecture

## Purpose

EventKit is a TypeScript-first framework for defining, detecting, handling, executing, and observing business events.

It evolves the current Hasura Event Detector into a general event framework where Hasura is one event source adapter rather than the central abstraction.

EventKit supports:

- Hasura database events
- Generic webhook events
- Cron and scheduled events
- Application-generated events
- Batch job events
- Future event sources

The primary goal is to preserve the event authoring experience that already works well in `event-handlers`, while making the framework source-agnostic, extensible, observable, and easier to reason about.

## Guiding Principle

Source adapters normalize incoming events.

Event modules define business events.

Handlers execute business behavior.

Plugins augment execution.

The event module remains the primary authoring experience and the most important abstraction in the system.

## Core Concepts

### Business Events

A business event is a named fact that occurred in the business domain.

Examples:

```txt
move.pickup.started
move.pickup.arrived
move.delivery.started
acertus.order.created
batch.ar.created
```

The event name represents business meaning, not the technical source that detected it.

For example, `move.pickup.started` may be detected from:

```ts
hasura.detector(...)
webhook.detector(...)
batchJob.detector(...)
app.detector(...)
```

The event identity remains the same.

### Event Sources

An event source is where a raw event originates.

Examples:

- Hasura Event Trigger
- Vendor webhook
- Cron schedule
- Application code
- Batch job table
- Queue message

Source adapters are responsible for converting raw source payloads into a normalized event envelope and exposing source-specific detector utilities.

The core framework should not know about Hasura tables, database rows, webhook signatures, or vendor-specific payload structures.

### Event Modules

Event modules are the center of the system.

Each business event lives in its own named module.

```txt
events/
  move.pickup.started.ts
  move.pickup.arrived.ts
  move.delivery.started.ts
  acertus.order.created.ts
```

Each module exports:

```ts
export const detector = ...
export const handler = ...
```

The detector should be the first meaningful thing developers see when opening the file.

### Detectors

A detector answers one question:

> Did this business event occur?

Detector code should optimize for readability.

Detector logic should read like a logical sentence. Complex criteria should be assigned to well-named variables, and the final return statement should clearly express the business rule.

Example:

```ts
export const detector = hasura.detector((ctx) => {
  const pickupStartedChanged =
    ctx.columnChanged('pickup_started');

  const pickupStartedWasSet =
    ctx.newRow.pickup_started !== null;

  const pickupStartedTimestampIsValid =
    isStatusTimeChangeValid(
      ctx.newRow.pickup_started,
      ctx.oldRow.pickup_started,
    );

  return (
    pickupStartedChanged &&
    pickupStartedWasSet &&
    pickupStartedTimestampIsValid
  );
});
```

Readability is more important than cleverness.

### Handlers

A handler answers one question:

> What jobs should run when this business event is detected?

Handlers should orchestrate jobs. They should not contain hidden business detection logic.

Example:

```ts
export const handler = async (event, ctx) => {
  return run(event, [
    job(updateMoveTimeline),
    job(notifyDealer),
  ]);
};
```

If conditional logic is needed to decide whether an event occurred, that logic belongs in the detector.

If the condition represents a different business fact, it should become a separate named event module.

## Source Adapter Responsibilities

Source adapters provide source-level context and utilities.

The Hasura source adapter may provide:

```ts
ctx.operation
ctx.table
ctx.oldRow
ctx.newRow
ctx.columnChanged()
ctx.columnAdded()
ctx.columnRemoved()
```

A webhook source adapter may provide:

```ts
ctx.headers
ctx.vendor
ctx.eventType
ctx.signature
ctx.payload
ctx.verifySignature()
```

A cron source adapter may provide:

```ts
ctx.scheduleName
ctx.scheduledAt
ctx.timezone
ctx.invocationId
```

Source adapters must not contain HopDrive domain logic.

Bad:

```ts
hasura.movePickupStarted(...)
hasura.isRideMove(...)
hasura.isDealerReady(...)
```

Good:

```ts
hasura.columnChanged(...)
hasura.operation
hasura.oldRow
hasura.newRow
```

Domain-specific helpers belong in application code.

Example:

```txt
event-handlers/
  lib/
    move-detector-helpers/
    appointment-detector-helpers/
    billing-detector-helpers/
```

## Normalized Event Envelope

EventKit core operates on a normalized event envelope.

```ts
export type EventEnvelope<TPayload = unknown, TMeta = unknown> = {
  id: string;
  source: string;
  sourceType: string;
  receivedAt: string;
  correlationId: string;
  payload: TPayload;
  meta?: TMeta;
  raw?: unknown;
};
```

Source adapters create this envelope from raw payloads.

The core runtime should only depend on the envelope and the event registry.

## Runtime Flow

At a high level:

```txt
Raw payload
  -> source adapter
  -> normalized event envelope
  -> event registry
  -> detector execution
  -> detected business events
  -> handler execution
  -> job execution
  -> plugin lifecycle hooks
  -> observability and persistence
```

Example:

```ts
const runtime = createEventRuntime({
  source: hasuraSource(),
  events,
  plugins: [
    observabilityPlugin(),
    trackingTokenPlugin(),
    batchJobsPlugin(),
  ],
});

await runtime.handle(rawPayload, requestContext);
```

## Plugin Responsibilities

Plugins augment execution without owning business logic.

Plugins may observe or modify lifecycle behavior around:

- runtime invocation
- source normalization
- detector execution
- event detection result
- handler execution
- job execution
- retries
- failures
- persistence
- observability
- logging
- correlation tracking

Plugins should be composable and source-agnostic unless explicitly designed for one source.

## Batch Jobs

Batch jobs should become a first-class plugin.

The core framework provides generic job execution primitives:

- job definition
- job execution
- job results
- timeout handling
- lifecycle hooks

The batch job plugin handles persistent state:

- execution tracking
- retries
- exception trapping
- state persistence
- lifecycle events
- observability integration

Batch jobs should be usable from any event source.

A batch job may be triggered by:

- a Hasura insert
- a webhook event
- a cron invocation
- application code
- another batch job

Batch job persistence is a plugin concern, not a core runtime concern.

## Observability

Observability should be promoted to a first-class package.

It should capture:

- invocations
- source payload metadata
- detected events
- skipped events
- detector duration
- handler duration
- job execution
- job results
- retries
- failures
- correlation IDs
- tracking tokens

The observability package should not be tied to Hasura.

The console should be organized around EventKit observability, not Hasura.

## Proposed Package Structure

```txt
packages/
  eventkit/
    Core runtime
    Event registry
    Event module types
    Job primitives
    Plugin lifecycle

  eventkit-source-hasura/
    Hasura source adapter
    Hasura detector context
    Hasura row and operation helpers

  eventkit-source-webhook/
    Generic webhook source adapter
    Signature verification hooks
    Vendor adapter primitives

  eventkit-source-cron/
    Scheduled event source adapter

  eventkit-plugin-observability/
    Observability lifecycle plugin
    GraphQL and SQL transports
    Event/job execution model

  eventkit-plugin-batchjobs/
    Persistent job state
    Retries
    Exception trapping
    Batch job lifecycle model

  eventkit-plugin-tracking-token/
    Correlation and tracking token extraction

  eventkit-console/
    Observability UI
    Event explorer
    Job explorer
    Debugging console

examples/
  hasura-netlify/
  webhook-vendor/
  cron/
  batchjobs/

docs/
  architecture.md
  migration.md
  event-modules.md
  source-adapters.md
  plugins.md
```

## Compatibility Goal

The existing `event-handlers` authoring model should remain recognizable.

Current style:

```ts
module.exports.detector = async (eventName, hasuraEvent) => {
  ...
};

module.exports.handler = async (eventName, hasuraEvent) => {
  ...
};
```

Future style:

```ts
export const detector = hasura.detector((ctx) => {
  ...
});

export const handler = async (event, ctx) => {
  ...
};
```

Migration should be incremental.

The existing Hasura Event Detector package can become a compatibility facade over EventKit while event modules are migrated gradually.

## Non-Goals

EventKit should not become a business rules package.

EventKit should not contain HopDrive-specific domain helpers.

EventKit should not assume Hasura.

EventKit should not force every event source into database-event semantics.

EventKit should not hide business event definitions inside handlers, queues, or plugins.

## Architectural Summary

EventKit exists to make business events explicit, readable, executable, observable, and source-agnostic.

The framework owns runtime mechanics.

Source adapters own payload interpretation.

Event modules own business event definitions.

Handlers own business behavior orchestration.

Jobs own side effects.

Plugins own execution augmentation.

This separation allows HopDrive to preserve the clarity of the current event-handler system while expanding beyond Hasura into webhooks, cron, app events, batch jobs, and future event sources.
:::

---

## [11] User — 2026-06-16 14:27:21 UTC

I like that architecture with one exception. I think we need to take a closer look at how the batchjobs work and what their purpose is. It’s ultimately triggered by a table using Hasura events so it might be confusing to have a batchjobs detector that needs Hasura detector features. Look at the code for batchjobs and its usage in event handlers.

---

## [12] Assistant (gpt-5-5-thinking) — 2026-06-16 14:27:24 UTC

I’ll dig into the batch job-specific functions, event modules, and helper libraries now, then revise the architectural interpretation around whether batch jobs are a source, plugin, or application pattern layered on Hasura.

---

## [13] Assistant (gpt-5-5-thinking) — 2026-06-16 14:28:01 UTC

Early finding: you’re right to question the “batchJob source adapter” framing. The current batch job events are ordinary Hasura-triggered DB events over a `batch_jobs` table, with detection based on row fields like `trigger_type` and `status`, then handlers run long/background work.

---

## [14] Assistant (gpt-5-5-thinking) — 2026-06-16 14:28:25 UTC

Agreed. After looking closer, I would **not** model batch jobs as a source adapter.

What the code shows:

Batch jobs are triggered by Hasura events on the `batch_jobs` table, not by a separate batch-job event source. The batch handler is a normal event-detector function for table `batch-jobs`, with Insert triggers. fileciteturn15file0

The batch event modules use Hasura detector concepts directly: `parseHasuraEvent`, `operation`, `dbEvent.new`, `columnHasChanged`, `trigger_type`, and `status`. fileciteturn28file0 fileciteturn29file0

The purpose of batch jobs seems to be:
1. Persist intent to do background work in `batch_jobs`.
2. Let Hasura trigger event-handlers from that row.
3. Route by `trigger_type`.
4. Pass the row as `options.batchJob`.
5. Wrap the actual long-running job with `@hopdrive/batchjobs`.
6. Capture logs/results/errors/state back to the batch job system. fileciteturn36file0 fileciteturn37file0

There is also utility code for creating delayed batch jobs and updating batch job status in the `batch_jobs` table. fileciteturn35file0

So I’d revise the architecture like this:

```txt
Not:
  eventkit-source-batchjob

Instead:
  eventkit-source-hasura
  eventkit-plugin-batchjobs
  eventkit-batchjobs-hasura-model
```

The detector remains Hasura:

```ts
export const detector = hasura.detector((ctx) => {
  const isInsert = ctx.operation === 'INSERT';
  const isArBatch = ctx.newRow.trigger_type === 'ar_v2';

  return isInsert && isArBatch;
});
```

The batch job behavior belongs around the job wrapper/runtime:

```ts
export const handler = async (event, ctx) => {
  return run(event, [
    batchJob(runARBatchV2, {
      batchJob: ctx.newRow,
    }),
  ]);
};
```

Architectural correction:

**Batch jobs are not an event source. Batch jobs are a persisted async-work pattern that can be triggered through normal event sources, especially Hasura.**

The plugin should own:
- status transitions
- output persistence
- log capture
- retries
- exception trapping
- delay semantics
- uniqueness/dedup helpers
- observability linking

But it should not own detection, because detection is still source-specific. In today’s case, detection depends on Hasura row semantics.

I’d update the architecture doc’s batch jobs section to say:

```txt
Batch jobs should become a first-class execution plugin, not a source adapter.

A batch job is represented by persistent state, usually a row in `batch_jobs`.
That row may be created by cron, app code, another event handler, or another job.

When the row is inserted or updated, Hasura emits a normal database event.
EventKit detects that event using the Hasura source adapter.

The batch job plugin then augments the job execution lifecycle by persisting status,
logs, output, failures, retries, and observability metadata.
```

This keeps the mental model cleaner:

```txt
Hasura detects the row change.
Event module decides which business batch event occurred.
Batch plugin manages execution state.
```

That is much less confusing than making `batchJob.detector(...)` need `hasura.columnChanged(...)`.

---

## [15] User — 2026-06-16 14:42:38 UTC

Can the features of batch jobs just become built in features of the event kit or does it make more sense as a plugin

---

## [16] Assistant (gpt-5-5-thinking) — 2026-06-16 14:42:41 UTC

It makes more sense as a **first-class plugin**, not built into core.

Core should include the primitives batch jobs need:

```txt
EventKit core:
- define events
- detect events
- run handlers
- run jobs
- job lifecycle hooks
- job result shape
- retries interface
- timeout/cancellation support
- correlation IDs
- plugin hooks
```

But batch jobs add opinions that are not universally true:

```txt
Batch plugin:
- persistent job rows
- status transitions
- output serialization
- log capture
- delayed execution
- uniqueness/dedup keys
- retry policy persistence
- exception trapping behavior
- GraphQL/SQL persistence adapter
```

Those are valuable, but they are not required for every event. A webhook handler might just need to run one quick job and return. A cron task might not need persisted state. A Hasura event might only need observability, not batch-job semantics.

So the clean split is:

```txt
Core owns execution mechanics.
Batch plugin owns durable execution state.
Hasura source owns detecting the batch_jobs row change.
```

The usage could look like:

```ts
export const detector = hasura.detector((ctx) => {
  const isInsert = ctx.operation === 'INSERT';
  const isArBatch = ctx.newRow.trigger_type === 'ar_v2';

  return isInsert && isArBatch;
});

export const handler = async (event, ctx) => {
  return run(event, [
    batchJob(runARBatchV2, {
      record: ctx.newRow,
    }),
  ]);
};
```

Or with plugin-driven wrapping:

```ts
export const handler = async (event, ctx) => {
  return run(event, [
    job(runARBatchV2, {
      batch: {
        record: ctx.newRow,
      },
    }),
  ]);
};
```

I prefer the second shape because `job(...)` stays universal and batch behavior is opt-in metadata.

Architectural wording I’d use:

> Batch jobs are not a separate event source. They are a durable execution mode for jobs. A batch job may be triggered by any source, but today HopDrive primarily triggers them through Hasura events on the `batch_jobs` table. EventKit core should provide the execution lifecycle that makes durable jobs possible, while the batch jobs plugin should provide persistence, status management, retry state, output capture, delay/dedup helpers, and exception trapping.

That keeps EventKit from becoming too database-shaped while still making batch jobs feel official.

---

## [17] User — 2026-06-16 14:47:16 UTC

The detector despite being Hasura based still has some reusable functions for batch specific detection. How could we handle that? Does batchjobs plugin export detector helpers?

---

## [18] Assistant (gpt-5-5-thinking) — 2026-06-16 14:47:18 UTC

Yes, but I would make them **batch detector helpers**, not a `batchJob.detector(...)` source.

The distinction:

```txt
hasura.detector(...)
  owns source context

batchJobs helpers
  understand batch_jobs row conventions
```

Example:

```ts
import { hasura } from '@hopdrive/eventkit-source-hasura';
import { batchJobs } from '@hopdrive/eventkit-plugin-batchjobs';

export const detector = hasura.detector((ctx) => {
  const isCreated =
    batchJobs.detectors.created(ctx);

  const isArV2 =
    batchJobs.detectors.triggerType(ctx, 'ar_v2');

  return isCreated && isArV2;
});
```

Or more readable:

```ts
export const detector = hasura.detector((ctx) => {
  const batchJobWasCreated =
    batchJobs.wasCreated(ctx);

  const isArV2BatchJob =
    batchJobs.hasTriggerType(ctx, 'ar_v2');

  return batchJobWasCreated && isArV2BatchJob;
});
```

The batch plugin can safely export helpers that operate on a **row-like detector context**, as long as they do not own the source.

I’d define the boundary like this:

```txt
Allowed in batch plugin helpers:
- isBatchJobInsert(ctx)
- isBatchJobPending(ctx)
- statusChangedTo(ctx, status)
- hasTriggerType(ctx, triggerType)
- getBatchJob(ctx)
- getBatchInput(ctx)
- getBatchId(ctx)
- delayElapsed(ctx)
- isRetryableStatus(ctx)

Not allowed:
- parsing raw Hasura payloads
- assuming Hasura is the only source
- owning hasura.detector(...)
- move/AR/paystub-specific helpers
```

To avoid coupling too tightly to Hasura, the helpers should depend on a minimal shape:

```ts
type RowChangeContext<T> = {
  operation: 'INSERT' | 'UPDATE' | 'DELETE' | 'MANUAL';
  oldRow?: T | null;
  newRow?: T | null;
  columnChanged?: (column: keyof T | string) => boolean;
};
```

Then Hasura can produce that shape, but future DB/queue adapters could too.

Final design recommendation:

```txt
eventkit-plugin-batchjobs exports:
- execution plugin
- batchJob() or job({ batch: ... }) wrapper behavior
- persistence adapters
- batch row types
- detector helper functions that work with row-change contexts
```

So the event still reads cleanly:

```ts
export const detector = hasura.detector((ctx) => {
  const batchJobWasCreated =
    batchJobs.detector.created(ctx);

  const isPayStubBatch =
    batchJobs.detector.triggerType(ctx, 'pay-stub');

  return batchJobWasCreated && isPayStubBatch;
});
```

That gives you reusable batch-specific detection without pretending batch jobs are a source.

---

## [19] User — 2026-06-16 14:53:00 UTC

Are there any features of the batch job system that could migrate into core to benefit all? Anything that has evolved from within batch jobs as a nice feature extension of the Hasura event detector package that doesn’t fully rely on batch specific stuff?

---

## [20] Assistant (gpt-5-5-thinking) — 2026-06-16 14:53:03 UTC

Yes. A few batch job ideas should migrate into **core**, because they benefit every job, not just persisted batch jobs.

I’d split it this way:

## Move into EventKit core

**1. Structured job lifecycle**

Core should formalize:

```txt
job.started
job.succeeded
job.failed
job.skipped
job.timedOut
job.retried
job.completed
```

Batch jobs currently rely on this idea, but observability, webhooks, cron, and normal Hasura events all benefit from it.

**2. Standard job result shape**

Core should own a consistent result contract:

```ts
type JobResult = {
  jobName: string;
  status: 'completed' | 'failed' | 'skipped' | 'timed_out';
  startedAt: Date;
  completedAt?: Date;
  durationMs: number;
  output?: unknown;
  error?: SerializedError;
  attempts?: number;
};
```

Batch persistence can store this, observability can display it, and handlers can return it.

**3. Safe error serialization**

Batch jobs need this because errors get persisted. But all plugins need it. Core should provide:

```ts
serializeError(error)
serializeOutput(output)
replaceCircularReferences(output)
```

The existing batch utility already handles circular references before persisting output. fileciteturn35file0

**4. Job logging surface**

Batch jobs have `log(...)` so job code can emit structured execution notes. fileciteturn36file0

That should become core:

```ts
ctx.log.info('Processing AR work unit', { batchJobId });
ctx.log.warn(...)
ctx.log.error(...)
```

Then plugins decide where logs go: console, Grafana, observability tables, batch output, etc.

**5. Retry and timeout primitives**

Core should understand retries/timeouts as job execution behavior.

Batch plugin can persist retry state, but the execution engine should know how to run:

```ts
job(fn, {
  retries: 3,
  timeoutMs: 30_000,
});
```

**6. Cancellation / abort signal**

This should also be core because serverless timeouts apply to any job, not only batch jobs.

**7. Job metadata**

Core should allow consistent metadata:

```ts
job(runARBatchV2, {
  name: 'runARBatchV2',
  tags: ['ar', 'batch'],
  metadata: {
    algorithm,
    moveId,
  },
});
```

Batch jobs, observability, and Grafana can all consume the same metadata.

## Keep in batch jobs plugin

These stay out of core:

```txt
- batch_jobs table persistence
- status column transitions
- trigger_type conventions
- delay_ms / delay_key behavior
- batch_id conventions
- uniqueness and dedup via DB constraints
- batch job row helpers
- updating output on the batch_jobs row
- creating delayed batch jobs
```

Those are useful, but they assume a persistence model and table semantics. The current utilities update `batch_jobs` status/output and insert delayed jobs, so that belongs in the batch plugin. fileciteturn35file0

## Best architecture

```txt
EventKit core:
  Durable-friendly job execution primitives

BatchJobs plugin:
  Durable persistence implementation
```

So batch jobs become an implementation of core extensibility, not a separate execution universe.

The design phrase I’d use:

**Core should make every job observable, retryable, cancellable, serializable, and loggable. The batch jobs plugin should make selected jobs durable.**

---

## [21] User — 2026-06-16 15:02:38 UTC

Does the Hasura event detector already have lifecycle events exposed to plugins that will enable those things to be part of core while batch jobs becomes a plugin that provides table specific semantics to aide Hasura detectors for the batch_jobs table as well as tie ins to the lifecycle events for logging and lifecycle etc

---

## [22] Assistant (gpt-5-5-thinking) — 2026-06-16 15:02:40 UTC

Yes. The current Hasura Event Detector already has most of the lifecycle surface needed.

It exposes plugin hooks for:

```txt
onInvocationStart / onInvocationEnd
onEventDetectionStart / onEventDetectionEnd
onEventHandlerStart / onEventHandlerEnd
onJobStart / onJobEnd
onLog
onError
flush
shutdown
```

Those hooks are already in the plugin system, and `onJobStart` can mutate `jobOptions`, which is how the current observability/tracking flow injects job execution context. fileciteturn17file0

So the future shape can be:

```txt
EventKit core:
  owns lifecycle hooks, job execution, job results, logging API, error serialization

BatchJobs plugin:
  subscribes to lifecycle hooks
  persists status/output/logs/errors
  exposes batch_jobs detector helpers
  provides createDelayedBatchJob / enqueue helpers
```

The batch plugin could do three things:

```ts
import { batchJobs } from '@hopdrive/eventkit-plugin-batchjobs';

export const detector = hasura.detector((ctx) => {
  const batchWasCreated = batchJobs.detector.created(ctx);
  const isArV2 = batchJobs.detector.triggerType(ctx, 'ar_v2');

  return batchWasCreated && isArV2;
});

export const handler = async (event, ctx) => {
  return run(event, [
    job(runARBatchV2, {
      batchJob: ctx.newRow,
      durable: true,
    }),
  ]);
};
```

Then internally:

```txt
onJobStart:
  mark batch job running
  attach batchJobId/jobExecutionId
  prepare log buffer

onLog:
  append log entry

onJobEnd:
  persist output
  mark completed/failed/skipped
  serialize errors safely

onError:
  trap unexpected failures
  update batch row

flush:
  persist buffered logs/output before timeout
```

The current system already hints at this split: batch utilities update `batch_jobs.status` and `output`, create delayed rows, and handle circular output before persistence. Those are plugin responsibilities, not core responsibilities. fileciteturn35file0

So: **yes, the existing plugin lifecycle is basically the bridge.** The rewrite should generalize the hook names away from Hasura payloads, then let `eventkit-plugin-batchjobs` attach to those hooks and also export `batch_jobs` row detector helpers for Hasura-based batch events.

---

## [23] User — 2026-06-16 15:16:56 UTC

So batch jobs gets a rewrite to just hook into the event detector lifecycle hooks instead of needing to be explicitly called within jobs?

---

## [24] Assistant (gpt-5-5-thinking) — 2026-06-16 15:16:58 UTC

Yes, that’s the cleaner rewrite.

Today:

```ts
const { batchJob } = require('@hopdrive/batchjobs');

run(eventName, hasuraEvent, [
  job(batchJob(async (...) => {
    ...
  }), { batchJob: dbEvent.new })
]);
```

Future:

```ts
run(event, [
  job(runARBatchV2, {
    durable: batchJobs.record(ctx.newRow),
  }),
]);
```

Or:

```ts
run(event, [
  batchJobs.job(runARBatchV2, {
    record: ctx.newRow,
  }),
]);
```

But the important change is: **job code should not have to call `batchJob(...)` to get lifecycle behavior.**

The batch plugin should hook into core lifecycle events:

```txt
onJobStart     -> mark batch row running, attach batch context
onLog          -> collect job logs
onJobEnd       -> persist output and final status
onError        -> persist failure details
flush          -> save partial logs/output before timeout
```

The job function just receives context:

```ts
async function runARBatchV2(ctx) {
  const batch = ctx.batch.record;
  ctx.log.info('Processing AR batch', { batchJobId: batch.id });

  ...
}
```

So the responsibility shifts:

```txt
Old:
  job author wraps function with batchJob()
  batchJob wrapper traps errors/logs/status

New:
  event module marks a job as durable/batch-backed
  EventKit emits lifecycle events
  BatchJobsPlugin reacts to lifecycle events
  job author writes normal job code
```

That is much better because batch behavior becomes composable with observability, tracing, Grafana logging, timeout handling, and retries. It also lets the same job run either durable or non-durable depending on metadata.

I’d still allow a convenience wrapper:

```ts
batchJobs.job(runARBatchV2, { record: ctx.newRow })
```

But it should only produce normal EventKit job metadata, not wrap execution itself.

---

## [25] User — 2026-06-16 15:24:31 UTC

Great, I think we have consensus on the future of batch jobs. Should we update our larger plan doc?

---

## [26] Assistant (gpt-5-5) — 2026-06-16 15:24:32 UTC

Yes, and I think that's actually one of the biggest architectural improvements we've discovered.

Right now there are effectively **two frameworks**:

```txt
Hasura Event Detector
  - detection
  - handlers
  - plugins
  - observability

BatchJobs
  - job lifecycle
  - retries
  - logging
  - exception trapping
  - persistence
```

The rewrite can collapse those into:

```txt
EventKit Core
  - event lifecycle
  - handler lifecycle
  - job lifecycle
  - logging lifecycle
  - plugin lifecycle

BatchJobs Plugin
  - persistence implementation
```

Which means the current:

```ts
batchJob(async () => {
  ...
})
```

becomes unnecessary.

Instead:

```ts
job(async () => {
  ...
})
```

always emits:

```txt
job.started
job.log
job.progress
job.completed
job.failed
```

And plugins decide what to do.

Example:

```txt
ObservabilityPlugin
  listens to lifecycle events
  writes event execution records

BatchJobsPlugin
  listens to lifecycle events
  updates batch_jobs table

GrafanaPlugin
  listens to lifecycle events
  ships logs

SentryPlugin
  listens to lifecycle events
  reports failures
```

This is actually much more aligned with how the current observability system evolved.

---

The more I think about it, the more I think there are **three levels of lifecycle** that should become explicit core concepts:

```txt
Invocation
  One inbound request

Event
  One detected business event

Job
  One executable unit
```

For example:

```txt
Invocation
└── move.pickup.started
    ├── updateTimeline
    ├── notifyDealer
    └── enqueueARBatch
```

Lifecycle:

```txt
invocation.started

event.detected

job.started(updateTimeline)
job.completed(updateTimeline)

job.started(notifyDealer)
job.completed(notifyDealer)

job.started(enqueueARBatch)
job.completed(enqueueARBatch)

event.completed

invocation.completed
```

Batch jobs simply become a consumer of that lifecycle.

---

I actually think there's one more step we should consider:

Instead of:

```ts
job(runARBatchV2)
```

the core could formalize a job execution context:

```ts
async function runARBatchV2(ctx) {
  ctx.log.info(...)

  ctx.progress(...)

  ctx.metadata(...)

  return result
}
```

because right now batch jobs and observability are both trying to inject execution context into jobs from different directions.

If EventKit owns:

```txt
JobContext
```

then plugins can enrich it:

```txt
ObservabilityPlugin
  adds traceId

BatchJobsPlugin
  adds batchJob record

TrackingTokenPlugin
  adds trackingToken

HasuraPlugin
  adds hasura metadata
```

without job authors needing wrappers.

---

So I would update the architecture document with a new principle:

```txt
Core owns execution lifecycle.

Plugins react to lifecycle.

Plugins should not wrap execution when lifecycle hooks can provide the same behavior.
```

That's the architectural change that allows BatchJobs to stop being a parallel framework and become a true EventKit plugin.

---

## [27] User — 2026-06-16 15:30:03 UTC

Great I like that. Is that eventkit lifecycle a significant departure from the current plugin lifecycle exposed in Hasura event detector?

---

## [28] Assistant (gpt-5-5-thinking) — 2026-06-16 15:30:04 UTC

No. It is more of a **rename, generalization, and formalization** than a significant departure.

The current Hasura Event Detector already has the major lifecycle concepts:

```txt
onInvocationStart / onInvocationEnd
onEventDetectionStart / onEventDetectionEnd
onEventHandlerStart / onEventHandlerEnd
onJobStart / onJobEnd
onLog
onError
flush
shutdown
```

That maps very naturally to EventKit:

```txt
Invocation lifecycle
Event lifecycle
Handler lifecycle
Job lifecycle
Log lifecycle
Error lifecycle
Flush/shutdown lifecycle
```

The meaningful changes would be:

```txt
Hasura-specific args become source-agnostic args.
```

For example:

```ts
onJobStart(jobName, jobOptions, eventName, hasuraEvent)
```

becomes something like:

```ts
onJobStart(ctx: JobLifecycleContext)
```

Where `ctx` includes:

```ts
{
  invocation,
  event,
  job,
  source,
  envelope,
  metadata,
  log,
  signal,
}
```

So the departure is not the lifecycle model. The departure is that the lifecycle payloads stop assuming `HasuraEventPayload`.

I’d frame it as:

```txt
Current plugin lifecycle:
  good shape, Hasura-coupled payloads

EventKit lifecycle:
  same shape, source-agnostic contexts
```

The one actual addition I’d make is **job progress / job checkpoint lifecycle**, because batch jobs would benefit from it:

```txt
onJobProgress
onJobCheckpoint
```

But even that is additive, not a rewrite.

So the migration can be incremental:
1. Keep the current hook phases.
2. Replace positional hook args with context objects.
3. Move Hasura-specific data under `ctx.source.hasura` or `ctx.envelope`.
4. Add `onJobProgress` and `onJobCheckpoint`.
5. Let BatchJobsPlugin subscribe to those hooks.

That means the current observability plugin architecture is a strong foundation. EventKit does not need a new lifecycle philosophy, just a less Hasura-specific API.

---

## [29] User — 2026-06-16 15:40:26 UTC

Great let’s update a plan to document all of this so we can give the work to agents

---

## [30] Assistant (gpt-5-5) — 2026-06-16 15:40:26 UTC

Yes. I would update the architecture document substantially because we've now made several important decisions that weren't present in the original draft.

The biggest change is that we've moved from:

```txt
EventKit
  Event Runtime

BatchJobs
  Separate execution framework
```

to:

```txt
EventKit
  Unified execution runtime

BatchJobs
  Plugin implementation
```

Which is a much stronger architecture.

I'd add a new section like this:

:::writing{variant="document" id="58371"}
# EventKit Execution Architecture

## Core Principle

EventKit owns execution.

Plugins react to execution.

Plugins should not wrap execution when lifecycle hooks can provide the same behavior.

This principle allows observability, durable jobs, retries, logging, tracing, persistence, and future extensions to share a single execution model.

## Execution Hierarchy

EventKit execution is organized into three nested layers.

```txt
Invocation
└── Event
    └── Job
```

### Invocation

An invocation represents a single inbound request into EventKit.

Examples:

- Hasura event trigger request
- Vendor webhook request
- Cron invocation
- Application event dispatch

### Event

An event represents a detected business event.

Examples:

```txt
move.pickup.started
move.pickup.arrived
acertus.order.created
```

A single invocation may produce multiple detected events.

### Job

A job represents a unit of executable work.

Jobs are the smallest observable execution primitive.

Examples:

```txt
updateTimeline
notifyDealer
createInvoice
enqueueBatch
```

## Lifecycle Model

EventKit exposes lifecycle events at all three execution layers.

### Invocation Lifecycle

```txt
invocation.started
invocation.completed
invocation.failed
```

### Event Lifecycle

```txt
event.detection.started
event.detected
event.skipped
event.handler.started
event.handler.completed
event.failed
```

### Job Lifecycle

```txt
job.started
job.completed
job.failed
job.skipped
job.timedOut
job.retried
```

### Logging Lifecycle

```txt
job.log
```

### Progress Lifecycle

```txt
job.progress
job.checkpoint
```

Progress and checkpoint events are new lifecycle concepts introduced in EventKit.

These support long-running durable jobs and future workflow-style execution.

## Job Context

Every job receives a JobContext.

```ts
async function runARBatchV2(ctx) {
  ctx.log.info('Processing');

  ctx.progress(50);

  return {
    processed: 100,
  };
}
```

The JobContext is the primary extension surface for plugins.

### Core Context

```ts
ctx.job
ctx.event
ctx.invocation
ctx.log
ctx.signal
ctx.metadata
```

### Plugin Context Extensions

Plugins may augment the JobContext.

Examples:

```ts
ctx.batchJob
ctx.traceId
ctx.trackingToken
ctx.hasura
ctx.observability
```

Jobs should not need wrappers to receive plugin functionality.

## Batch Jobs Architecture

Batch jobs are not an event source.

Batch jobs are not a separate execution framework.

Batch jobs are a durable execution plugin built on top of EventKit lifecycle events.

### Responsibilities

The BatchJobs plugin owns:

- batch_jobs persistence
- status transitions
- retries
- delayed execution metadata
- output persistence
- exception trapping
- execution history
- batch-specific detector helpers

### Responsibilities Not Owned By BatchJobs

The BatchJobs plugin does not own:

- event detection
- handler execution
- job execution
- logging APIs
- retry mechanics
- lifecycle definitions

These belong to EventKit core.

### Lifecycle Integration

The BatchJobs plugin subscribes to lifecycle events.

```txt
job.started
  -> mark running

job.log
  -> persist log

job.progress
  -> persist progress

job.completed
  -> persist output

job.failed
  -> persist failure
```

No batch-specific execution wrapper is required.

## Detector Helper Architecture

Source adapters expose source-specific detector helpers.

Example:

```ts
hasura.detector(...)
```

BatchJobs may expose reusable detector helpers for batch_jobs row semantics.

Example:

```ts
batchJobs.detector.created(ctx)

batchJobs.detector.triggerType(
  ctx,
  'ar_v2',
)
```

These helpers operate on row-change contexts.

They do not own source detection.

### Ownership Boundary

Hasura owns:

```txt
operation
table
oldRow
newRow
columnChanged()
```

BatchJobs owns:

```txt
batch row conventions
trigger_type helpers
status helpers
batch row access
```

HopDrive owns:

```txt
AR rules
Paystub rules
Move rules
Dealer rules
```

## Migration Strategy

### Phase 1

Create EventKit core runtime.

Preserve existing Hasura Event Detector lifecycle concepts.

### Phase 2

Convert lifecycle hooks to context-based APIs.

Remove Hasura-specific assumptions from plugin interfaces.

### Phase 3

Move BatchJobs functionality into EventKit lifecycle subscribers.

Remove execution wrappers from BatchJobs.

### Phase 4

Convert observability to a first-class EventKit plugin.

### Phase 5

Introduce additional source adapters:

- webhook
- cron
- application events

while preserving the existing event module authoring model.
:::

For agent work, I'd actually split the project into four parallel tracks:

1. **Core Runtime Refactor**
   - Define EventKit lifecycle
   - Define context objects
   - Define plugin API

2. **Hasura Adapter Migration**
   - Move Hasura-specific logic into source package
   - Preserve detector ergonomics

3. **BatchJobs Rewrite**
   - Remove execution wrappers
   - Convert to lifecycle subscriber
   - Extract detector helpers

4. **Observability/Console Consolidation**
   - Reorganize observability package
   - Align console with EventKit rather than Hasura

Those can largely proceed independently once this architecture is documented.

---

## [31] User — 2026-06-16 16:56:12 UTC

Great let’s also write a migration plan. Get all these docs made as project plans

---

## [32] Assistant (gpt-5-5) — 2026-06-16 16:56:13 UTC

I would create **three project documents**, not one.

The architecture is becoming substantial enough that mixing vision, implementation strategy, and work breakdown into one file will make it difficult for agents to consume.

---

:::writing{variant="document" id="28471"}
# EventKit Project Documentation Structure

## Purpose

The EventKit rewrite should be driven by three primary planning documents.

Each document has a distinct audience and responsibility.

## Document Structure

```txt
docs/

  architecture/
    ARCHITECTURE.md
    EXECUTION_MODEL.md
    SOURCE_ADAPTERS.md
    PLUGINS.md

  planning/
    MIGRATION_PLAN.md
    IMPLEMENTATION_ROADMAP.md
    AGENT_WORKSTREAMS.md
```

---

# ARCHITECTURE.md

Audience:

- Architects
- Future maintainers
- Contributors

Purpose:

Defines the permanent architectural decisions.

Contains:

- Vision
- Core principles
- Event model
- Event modules
- Source adapters
- Plugin architecture
- BatchJobs architecture
- Observability architecture
- Package boundaries

Must avoid implementation details whenever possible.

Question answered:

> What is EventKit?

---

# EXECUTION_MODEL.md

Audience:

- Runtime contributors
- Plugin authors

Purpose:

Defines the execution lifecycle.

Contains:

- Invocation lifecycle
- Event lifecycle
- Handler lifecycle
- Job lifecycle
- Progress lifecycle
- Logging lifecycle
- Error lifecycle
- Context objects
- Plugin extension model

Question answered:

> How does EventKit execute work?

---

# SOURCE_ADAPTERS.md

Audience:

- Adapter authors

Purpose:

Defines responsibilities and constraints for source adapters.

Contains:

- Hasura adapter
- Webhook adapter
- Cron adapter
- App event adapter
- Future adapter requirements

Defines:

```txt
Source adapters normalize events.

Source adapters expose source-specific context.

Source adapters never contain business logic.
```

Question answered:

> How are external systems connected to EventKit?

---

# PLUGINS.md

Audience:

- Plugin authors

Purpose:

Defines plugin responsibilities.

Contains:

- Lifecycle subscriptions
- Context augmentation
- Observability
- BatchJobs
- Tracking tokens
- Logging
- Future plugin examples

Defines:

```txt
Plugins react to execution.

Plugins do not own execution.
```

Question answered:

> How do extensions integrate with EventKit?
:::

---

:::writing{variant="document" id="57214"}
# MIGRATION_PLAN.md

## Goal

Transform Hasura Event Detector into EventKit while preserving compatibility with existing event-handlers implementations.

The migration must be incremental.

No large-scale event module rewrite should be required.

---

## Phase 0

### Establish Architecture

Deliverables:

- ARCHITECTURE.md
- EXECUTION_MODEL.md
- SOURCE_ADAPTERS.md
- PLUGINS.md

Success Criteria:

- Architectural decisions finalized.
- Package boundaries finalized.

---

## Phase 1

### Create EventKit Core

Deliverables:

```txt
packages/eventkit
```

Responsibilities:

- Event registry
- Event modules
- Runtime
- Job execution
- Plugin lifecycle

Success Criteria:

Existing Hasura Event Detector behavior reproducible using EventKit Core.

---

## Phase 2

### Extract Hasura Source Adapter

Deliverables:

```txt
packages/eventkit-source-hasura
```

Move:

- parseHasuraEvent
- Hasura payload types
- columnChanged helpers
- row helpers
- operation helpers

Success Criteria:

No Hasura-specific concepts remain in EventKit Core.

---

## Phase 3

### Convert Plugin Lifecycle

Current:

```txt
Hasura-oriented hook signatures
```

Target:

```txt
Context-oriented hook signatures
```

Introduce:

```txt
InvocationContext
EventContext
JobContext
```

Success Criteria:

Existing observability plugin can operate entirely through contexts.

---

## Phase 4

### Rewrite BatchJobs

Remove:

```txt
Execution wrappers
```

Introduce:

```txt
Lifecycle subscribers
```

BatchJobs becomes:

```txt
eventkit-plugin-batchjobs
```

Responsibilities:

- Persistence
- Retries
- Output storage
- Logs
- Delay metadata
- Batch detector helpers

Success Criteria:

BatchJobs no longer controls execution.

---

## Phase 5

### Promote Observability

Create:

```txt
eventkit-plugin-observability
eventkit-console
```

Move observability into first-class package structure.

Success Criteria:

Console is EventKit-focused rather than Hasura-focused.

---

## Phase 6

### Introduce New Sources

Add:

```txt
eventkit-source-webhook
eventkit-source-cron
eventkit-source-app
```

Success Criteria:

Business event modules remain unchanged while source adapters vary.

---

## Phase 7

### Compatibility Layer Removal

Deprecate:

```txt
@hopdrive/hasura-event-detector
```

Replace with:

```txt
@hopdrive/eventkit
```

Success Criteria:

All active repositories operate on EventKit packages.
:::

---

:::writing{variant="document" id="81365"}
# AGENT_WORKSTREAMS.md

## Workstream A

### EventKit Core Runtime

Repository:

```txt
eventkit
```

Responsibilities:

- Runtime
- Registry
- Job execution
- Lifecycle model
- Context model

Deliverables:

- EventKit Core
- Lifecycle documentation
- Context APIs

---

## Workstream B

### Hasura Source Adapter

Repository:

```txt
eventkit-source-hasura
```

Responsibilities:

- Hasura payload parsing
- Detector helpers
- Row helpers
- Operation helpers

Deliverables:

- Source adapter package
- Migration compatibility layer

---

## Workstream C

### BatchJobs Rewrite

Repository:

```txt
eventkit-plugin-batchjobs
```

Responsibilities:

- Lifecycle subscribers
- Persistence
- Status transitions
- Retry state
- Detector helpers

Deliverables:

- BatchJobs plugin
- Removal of execution wrappers

---

## Workstream D

### Observability Platform

Repositories:

```txt
eventkit-plugin-observability
eventkit-console
```

Responsibilities:

- Event telemetry
- Job telemetry
- Log ingestion
- Console experience

Deliverables:

- Observability plugin
- Console refactor

---

## Workstream E

### Future Sources

Repositories:

```txt
eventkit-source-webhook
eventkit-source-cron
eventkit-source-app
```

Responsibilities:

- Source adapter specifications
- Example implementations

Deliverables:

- Adapter framework
- Example integrations

---

## Parallelization Strategy

Workstreams A-D may execute concurrently after architecture approval.

Workstream E begins once EventKit Core APIs stabilize.

This minimizes coupling and allows multiple implementation agents to operate simultaneously.
:::

These three planning docs plus the architecture docs give you enough structure to hand individual workstreams to agents without them needing to rediscover the design decisions we've already made. The most important new decision that should be reflected everywhere is:

> **BatchJobs is no longer an execution framework. BatchJobs becomes a lifecycle-driven durability plugin built on top of EventKit Core.**

That is the largest architectural shift from the current system and affects package boundaries, plugin APIs, observability, and migration strategy.

---

## [33] User — 2026-06-16 18:25:40 UTC

Make them downloadable file

---

## [34] Assistant (gpt-5-5) — 2026-06-16 18:26:23 UTC

I've created the downloadable project planning files:

- [ARCHITECTURE_AND_EXECUTION_PLAN.md](sandbox:/mnt/data/ARCHITECTURE_AND_EXECUTION_PLAN.md)
- [MIGRATION_PLAN.md](sandbox:/mnt/data/MIGRATION_PLAN.md)
- [AGENT_WORKSTREAMS.md](sandbox:/mnt/data/AGENT_WORKSTREAMS.md)

These are concise starter versions. Given how much we've refined the design, the next thing I'd recommend is generating a more complete planning package with:

- `ARCHITECTURE.md` (full architecture spec, 10-20 pages)
- `EXECUTION_MODEL.md`
- `PLUGINS.md`
- `SOURCE_ADAPTERS.md`
- `BATCHJOBS_REWRITE.md`
- `OBSERVABILITY_AND_CONSOLE.md`
- `MIGRATION_PLAN.md`
- `AGENT_WORKSTREAMS.md`
- `PACKAGE_RESTRUCTURE.md`
- `NAMING_AND_COMPATIBILITY.md`

That would be detailed enough to hand directly to implementation agents with minimal additional context.

---

## [35] User — 2026-06-26 00:49:07 UTC

Write a single snippet of text I copy at once that describes everything we covered in this thread

---

## [36] Assistant (gpt-5-5) — 2026-06-26 00:49:08 UTC

:::writing{variant="document" id="84731"}
# EventKit Rewrite Project Plan

## Vision

The current Hasura Event Detector will evolve into **EventKit**, a general-purpose TypeScript framework for detecting, handling, executing, and observing business events. The framework is no longer centered around Hasura. Instead, Hasura becomes the first of many source adapters. EventKit should support Hasura database events, generic webhooks, cron and scheduled events, application-generated events, persisted background work, and future event sources while preserving the event authoring experience that exists today in `event-handlers`.

## Core Philosophy

The framework is built around a clear separation of responsibilities.

- Source adapters normalize inbound events and expose source-specific detection utilities.
- Event modules define business events.
- Handlers orchestrate business behavior.
- Jobs execute side effects.
- Plugins augment execution.
- The runtime owns execution.

Business event identity must remain independent from the source that detected it.

For example, `move.pickup.started` is always the business event regardless of whether it was detected from a Hasura row change, a vendor webhook, an application event, or another source.

## Event Modules

The existing event module pattern is preserved because it has proven to be one of the strongest aspects of the current system.

Each business event lives in its own module:

```text
move.pickup.started
move.pickup.arrived
move.delivery.started
acertus.order.created
```

Each module exports:

```ts
export const detector = ...
export const handler = ...
```

The detector remains the first thing developers see when opening a file.

## Detector Design

Detector readability is a primary design goal.

Detectors should read like logical business rules.

Complex criteria should be assigned to well-named variables and the final return statement should clearly describe why the business event occurred.

Example:

```ts
const pickupStartedChanged =
  ctx.columnChanged("pickup_started");

const pickupStartedWasSet =
  ctx.newRow.pickup_started !== null;

return (
  pickupStartedChanged &&
  pickupStartedWasSet
);
```

Readability always takes precedence over cleverness.

## Source Adapters

Source adapters provide source-specific context and helpers but never contain domain logic.

The Hasura adapter may expose:

- operation
- table
- oldRow
- newRow
- columnChanged()
- columnAdded()
- columnRemoved()

The webhook adapter may expose:

- headers
- payload
- signature
- vendor
- eventType

The core runtime must never understand Hasura-specific concepts.

Business logic belongs in the application, not inside EventKit.

## Execution Model

Execution is organized into three nested levels.

```text
Invocation
└── Event
    └── Job
```

### Invocation

A single inbound request.

Examples:

- Hasura event trigger
- Vendor webhook
- Cron invocation
- Application dispatch

### Event

A detected business event.

Examples:

```text
move.pickup.started
move.delivery.completed
acertus.order.created
```

### Job

A unit of executable work.

Examples:

```text
updateTimeline
notifyDealer
generateInvoice
enqueueBatch
```

## EventKit Lifecycle

The existing Hasura Event Detector lifecycle is preserved conceptually but generalized into source-agnostic context objects.

Lifecycle stages include:

### Invocation

- invocation.started
- invocation.completed
- invocation.failed

### Event

- event.detection.started
- event.detected
- event.skipped
- event.handler.started
- event.handler.completed
- event.failed

### Job

- job.started
- job.completed
- job.failed
- job.skipped
- job.retried
- job.timedOut

### Logging

- job.log

### Progress

- job.progress
- job.checkpoint

Plugins subscribe to lifecycle events instead of wrapping execution.

## Job Context

Every job receives a shared JobContext.

Core context includes:

- invocation
- event
- job
- log
- metadata
- cancellation signal

Plugins may augment the context with:

- batchJob
- traceId
- trackingToken
- observability
- hasura

This removes the need for wrapper functions that inject execution state.

## BatchJobs Rewrite

One of the biggest architectural changes is the redesign of the BatchJobs system.

Batch jobs are **not** an event source.

Today, batch jobs are implemented as Hasura-triggered events over the `batch_jobs` table, combined with wrapper functions that provide durability and persistence.

The new architecture separates those concerns.

Hasura continues to detect inserts and updates to the `batch_jobs` table.

The BatchJobs package becomes a lifecycle-driven EventKit plugin.

Its responsibilities become:

- execution persistence
- retries
- delayed execution metadata
- output persistence
- exception trapping
- execution history
- status transitions
- detector helpers for `batch_jobs` row semantics

Execution itself belongs to EventKit Core.

Instead of wrapping job execution, the BatchJobs plugin subscribes to lifecycle events such as:

- job.started
- job.log
- job.progress
- job.completed
- job.failed

This allows durability to become an implementation detail instead of a separate execution framework.

The plugin may also export reusable detector helpers for batch-specific row semantics while leaving Hasura detection inside the Hasura source adapter.

## Observability

Observability becomes a first-class EventKit plugin.

The console becomes an EventKit console rather than a Hasura Event Detector console.

Observability captures:

- invocations
- detected events
- skipped events
- handler execution
- job execution
- retries
- failures
- durations
- logs
- correlation IDs
- tracking tokens

## Package Structure

```text
packages/

eventkit/
  Core runtime
  Registry
  Lifecycle
  Job execution

eventkit-source-hasura/
  Hasura adapter
  Detector helpers

eventkit-source-webhook/
  Generic webhook adapter

eventkit-source-cron/
  Scheduled events

eventkit-source-app/
  Application events

eventkit-plugin-observability/
  Observability

eventkit-plugin-batchjobs/
  Durable execution
  Persistence
  Detector helpers

eventkit-plugin-tracking-token/

eventkit-console/
  Event explorer
  Job explorer
  Observability UI
```

## Core Principles

- Event modules remain the primary authoring experience.
- Business event identity is independent from event source.
- Source adapters expose source-specific concepts only.
- Plugins react to execution.
- Plugins do not own execution.
- EventKit owns execution.
- BatchJobs becomes a lifecycle subscriber instead of an execution wrapper.
- Existing lifecycle concepts from Hasura Event Detector are preserved and generalized through context-based APIs.
- The migration should be incremental and preserve compatibility with existing event modules wherever possible.

## Migration Plan

### Phase 0

Finalize architecture documentation and execution model.

### Phase 1

Build EventKit Core.

### Phase 2

Extract the Hasura adapter into its own package.

### Phase 3

Generalize the plugin lifecycle into context-based APIs.

### Phase 4

Rewrite BatchJobs as a lifecycle-driven plugin.

### Phase 5

Promote observability into first-class packages and reorganize the console.

### Phase 6

Add webhook, cron, and application source adapters.

### Phase 7

Deprecate the Hasura Event Detector compatibility layer after all repositories have migrated.

## Agent Workstreams

The implementation is designed for parallel development.

**Workstream A:** EventKit Core Runtime

- lifecycle
- registry
- execution
- contexts

**Workstream B:** Hasura Source Adapter

- payload parsing
- detector helpers
- compatibility

**Workstream C:** BatchJobs Plugin

- lifecycle subscribers
- persistence
- retries
- detector helpers

**Workstream D:** Observability Platform

- observability plugin
- console
- telemetry

**Workstream E:** Future Source Adapters

- webhook
- cron
- application events

These workstreams can proceed largely independently once the architecture is finalized, enabling multiple implementation agents to work concurrently while preserving a consistent overall design.
:::

---

## [37] User — 2026-06-26 01:08:18 UTC

Yes now write all the other files

---

## [38] Assistant (gpt-5-5) — 2026-06-26 01:09:52 UTC

I've generated the additional planning documents:

- [EXECUTION_MODEL.md](sandbox:/mnt/data/EXECUTION_MODEL.md)
- [PLUGINS.md](sandbox:/mnt/data/PLUGINS.md)
- [SOURCE_ADAPTERS.md](sandbox:/mnt/data/SOURCE_ADAPTERS.md)
- [BATCHJOBS_REWRITE.md](sandbox:/mnt/data/BATCHJOBS_REWRITE.md)
- [OBSERVABILITY_AND_CONSOLE.md](sandbox:/mnt/data/OBSERVABILITY_AND_CONSOLE.md)
- [PACKAGE_RESTRUCTURE.md](sandbox:/mnt/data/PACKAGE_RESTRUCTURE.md)
- [NAMING_AND_COMPATIBILITY.md](sandbox:/mnt/data/NAMING_AND_COMPATIBILITY.md)

One recommendation before implementation begins: these documents should evolve from outlines into a proper design specification (roughly 50 to 100 pages across all docs). What we've produced here is an excellent project scaffold, but the next iteration should include concrete TypeScript interfaces, lifecycle diagrams, package APIs, migration examples, and rationale for each architectural decision. That level of detail will allow implementation agents to work largely independently while remaining aligned with the overall design.

---

## [39] User — 2026-06-26 01:18:02 UTC

Is there a type for the normalized detected event shape that has been decided yet

---

## [40] Assistant (gpt-5-5-thinking) — 2026-06-26 01:18:04 UTC

Not fully decided yet. We have the concept, but not a final type.

The current working shape is roughly:

```ts
export type EventEnvelope<TPayload = unknown, TMeta = unknown> = {
  id: string;
  source: string;
  sourceType: string;
  receivedAt: string;
  correlationId: string;
  payload: TPayload;
  meta?: TMeta;
  raw?: unknown;
};
```

But for a **detected business event**, I think we need a second normalized type:

```ts
export type DetectedEvent<
  TPayload = unknown,
  TSourceContext = unknown,
  TMeta = Record<string, unknown>,
> = {
  id: string;
  name: EventName;
  source: EventSourceName;
  invocationId: string;
  correlationId: string;
  detectedAt: Date;

  envelope: EventEnvelope<TPayload>;
  sourceContext: TSourceContext;

  metadata: TMeta;
};
```

So the distinction would be:

```txt
EventEnvelope
  normalized inbound source payload

DetectedEvent
  normalized business event that matched a detector
```

Example:

```ts
const detected: DetectedEvent<HasuraPayload, HasuraDetectorContext> = {
  id: '...',
  name: 'move.pickup.started',
  source: 'hasura',
  invocationId: '...',
  correlationId: '...',
  detectedAt: new Date(),
  envelope,
  sourceContext: hasuraCtx,
  metadata: {
    detectorDurationMs: 4,
  },
};
```

I’d document this as an open decision, but my recommendation is:

```txt
EventEnvelope = what came in
DetectedEvent = what business event was detected
JobExecution = what work ran because of it
```

---

## [41] User — 2026-06-26 01:35:07 UTC

We’ve finalized most of EventKit, but we have not finalized the detector context API.

We know each source adapter provides a specialized detector context (Hasura, Webhook, Cron, etc.), but we have not decided what the common interface should look like.

Please propose:

1. The responsibilities of EventEnvelope.
2. The responsibilities of DetectorContext.
3. The responsibilities of source-specific contexts like HasuraDetectorContext.
4. Which helpers belong in the framework versus application code.
5. An example detector implementation that demonstrates the desired readability.
6. Recommended TypeScript interfaces for these types.

The goal is maximizing detector readability while keeping EventKit source-agnostic.

---

## [42] Assistant (gpt-5-5-thinking) — 2026-06-26 01:35:09 UTC

Yes. Here is the proposed detector-context spec.

:::writing{variant="document" id="82417"}
# EventKit Detector Context API Proposal

## 1. EventEnvelope Responsibilities

`EventEnvelope` is the normalized representation of the inbound source payload.

It answers:

> What came into EventKit?

Responsibilities:

- Identify the inbound invocation payload.
- Preserve source identity.
- Preserve raw payload access.
- Carry correlation and tracing identifiers.
- Provide normalized metadata common to all sources.
- Remain source-agnostic.

`EventEnvelope` should not expose source-specific helpers like `columnChanged()` or `verifySignature()`.

```ts
export interface EventEnvelope<
  TPayload = unknown,
  TSourceMeta = Record<string, unknown>,
> {
  id: string;
  source: EventSourceName;
  sourceType: EventSourceType;
  receivedAt: Date;
  correlationId: string;
  payload: TPayload;
  meta: TSourceMeta;
  raw?: unknown;
}
```

Example source types:

```ts
export type EventSourceType =
  | 'database'
  | 'webhook'
  | 'cron'
  | 'application'
  | 'queue'
  | 'manual';
```

## 2. DetectorContext Responsibilities

`DetectorContext` is the common context available to every detector, regardless of source.

It answers:

> What does a detector need in order to evaluate a business event?

Responsibilities:

- Provide access to the normalized envelope.
- Provide source identity.
- Provide event module identity.
- Provide correlation metadata.
- Provide safe metadata APIs.
- Provide optional debug/logging helpers.
- Provide type-safe access to source-specific context through generics.

It should not include Hasura, webhook, cron, or vendor-specific APIs directly.

```ts
export interface DetectorContext<
  TPayload = unknown,
  TSourceContext = unknown,
  TSourceMeta = Record<string, unknown>,
> {
  eventName: EventName;
  envelope: EventEnvelope<TPayload, TSourceMeta>;

  source: EventSourceName;
  sourceType: EventSourceType;

  invocationId: string;
  correlationId: string;
  receivedAt: Date;

  sourceContext: TSourceContext;

  metadata: DetectorMetadata;

  log?: DetectorLogger;
}
```

Supporting types:

```ts
export type EventName = string & { readonly __eventName: unique symbol };
export type EventSourceName = string & { readonly __eventSourceName: unique symbol };

export interface DetectorMetadata {
  tags?: string[];
  description?: string;
  [key: string]: unknown;
}

export interface DetectorLogger {
  debug(message: string, data?: Record<string, unknown>): void;
}
```

## 3. Source-Specific Context Responsibilities

A source-specific detector context provides ergonomic, readable helpers for one source.

It answers:

> What source-level facts make detector code easy to read?

Source-specific contexts may expose:

- Parsed source payload.
- Source-level operation type.
- Source-level identity.
- Common source utilities.
- Safe helper methods.

They must not expose HopDrive business logic.

### HasuraDetectorContext

Hasura owns database event semantics.

```ts
export interface HasuraDetectorContext<
  TNewRow = Record<string, unknown>,
  TOldRow = TNewRow,
> extends DetectorContext<
  HasuraEventPayload<TNewRow>,
  HasuraSourceContext<TNewRow, TOldRow>,
  HasuraSourceMeta
> {
  operation: HasuraOperation;
  schema: string;
  table: string;

  oldRow: TOldRow | null;
  newRow: TNewRow | null;

  row: TNewRow | TOldRow | null;

  columnChanged(column: keyof TNewRow & string): boolean;
  columnAdded(column: keyof TNewRow & string): boolean;
  columnRemoved(column: keyof TOldRow & string): boolean;

  inserted(): boolean;
  updated(): boolean;
  deleted(): boolean;
  manuallyInvoked(): boolean;
}
```

### WebhookDetectorContext

Webhook owns HTTP and vendor payload semantics.

```ts
export interface WebhookDetectorContext<
  TPayload = unknown,
  THeaders = Record<string, string>,
> extends DetectorContext<TPayload, WebhookSourceContext<TPayload, THeaders>> {
  method: string;
  headers: THeaders;
  vendor?: string;
  eventType?: string;
  body: TPayload;

  header(name: string): string | undefined;
  hasHeader(name: string): boolean;
}
```

Signature verification should likely be source adapter or middleware behavior, not detector business logic. Detectors may inspect whether verification succeeded:

```ts
ctx.signature.verified
```

but should not usually call verification themselves.

### CronDetectorContext

Cron owns schedule semantics.

```ts
export interface CronDetectorContext<TPayload = unknown>
  extends DetectorContext<TPayload, CronSourceContext> {
  scheduleName: string;
  scheduledAt: Date;
  timezone?: string;
}
```

## 4. Framework Helpers vs Application Helpers

### Belongs in EventKit Core

Core helpers must be source-agnostic:

- Event envelope access.
- Correlation IDs.
- Invocation IDs.
- Metadata.
- Debug logging.
- Type guards for EventKit primitives.
- Safe object helpers.
- Error/output serialization.
- Lifecycle context helpers.

Examples:

```ts
ctx.correlationId
ctx.invocationId
ctx.envelope
ctx.metadata
ctx.log?.debug(...)
```

### Belongs in Source Adapters

Source adapters own source-level concepts.

Hasura adapter:

```ts
ctx.operation
ctx.oldRow
ctx.newRow
ctx.columnChanged('status')
ctx.inserted()
ctx.updated()
```

Webhook adapter:

```ts
ctx.headers
ctx.eventType
ctx.vendor
ctx.header('x-signature')
```

Cron adapter:

```ts
ctx.scheduleName
ctx.scheduledAt
```

### Belongs in Plugins

Plugins may provide reusable helpers for plugin-owned semantics.

BatchJobs plugin may expose helpers for `batch_jobs` row conventions:

```ts
batchJobs.detector.created(ctx)
batchJobs.detector.triggerType(ctx, 'ar_v2')
batchJobs.detector.statusChangedTo(ctx, 'pending')
batchJobs.detector.record(ctx)
```

These helpers operate on row-change contexts but do not own Hasura parsing.

### Belongs in Application Code

Application code owns domain logic.

Examples:

```ts
isRideMove(row)
isPickupTimestampValid(newRow, oldRow)
isDealerReadyForDispatch(row)
isArEligibleMove(row)
```

These should live in application packages, such as:

```txt
event-handlers/
  lib/
    move-detector-helpers/
    ar-detector-helpers/
    appointment-detector-helpers/
```

## 5. Example Detector Implementation

```ts
import { hasura } from '@hopdrive/eventkit-source-hasura';
import { isStatusTimeChangeValid } from '../lib/move-detector-helpers';

export const detector = hasura.detector<MoveRow>((ctx) => {
  const moveWasUpdated =
    ctx.updated();

  const pickupStartedChanged =
    ctx.columnChanged('pickup_started');

  const pickupStartedWasSet =
    ctx.newRow?.pickup_started !== null;

  const pickupStartedTimestampIsValid =
    isStatusTimeChangeValid(
      ctx.newRow?.pickup_started,
      ctx.oldRow?.pickup_started,
    );

  return (
    moveWasUpdated &&
    pickupStartedChanged &&
    pickupStartedWasSet &&
    pickupStartedTimestampIsValid
  );
});
```

Batch job example:

```ts
import { hasura } from '@hopdrive/eventkit-source-hasura';
import { batchJobs } from '@hopdrive/eventkit-plugin-batchjobs';

export const detector = hasura.detector<BatchJobRow>((ctx) => {
  const batchJobWasCreated =
    batchJobs.detector.created(ctx);

  const isArV2Batch =
    batchJobs.detector.triggerType(ctx, 'ar_v2');

  return (
    batchJobWasCreated &&
    isArV2Batch
  );
});
```

## 6. Recommended TypeScript Interfaces

```ts
export interface SourceAdapter<
  TRaw = unknown,
  TPayload = unknown,
  TSourceContext = unknown,
  TSourceMeta = Record<string, unknown>,
> {
  name: EventSourceName;
  type: EventSourceType;

  normalize(raw: TRaw, input: SourceAdapterInput): Promise<EventEnvelope<TPayload, TSourceMeta>>;

  createDetectorContext(
    base: BaseDetectorContext<TPayload, TSourceMeta>,
  ): TSourceContext;
}
```

```ts
export interface BaseDetectorContext<
  TPayload = unknown,
  TSourceMeta = Record<string, unknown>,
> {
  eventName: EventName;
  envelope: EventEnvelope<TPayload, TSourceMeta>;
  invocationId: string;
  correlationId: string;
  source: EventSourceName;
  sourceType: EventSourceType;
  receivedAt: Date;
  metadata: DetectorMetadata;
  log?: DetectorLogger;
}
```

```ts
export type DetectorFunction<TContext extends DetectorContext = DetectorContext> =
  (ctx: TContext) => boolean | Promise<boolean>;
```

```ts
export interface EventModule<
  TDetectorContext extends DetectorContext = DetectorContext,
  THandlerContext = unknown,
> {
  name: EventName;
  detector: DetectorFunction<TDetectorContext>;
  handler: HandlerFunction<THandlerContext>;
}
```

```ts
export interface DetectedEvent<
  TPayload = unknown,
  TSourceContext = unknown,
  TSourceMeta = Record<string, unknown>,
> {
  id: string;
  name: EventName;
  detectedAt: Date;

  invocationId: string;
  correlationId: string;

  source: EventSourceName;
  sourceType: EventSourceType;

  envelope: EventEnvelope<TPayload, TSourceMeta>;
  detectorContext: TSourceContext;

  detectorDurationMs: number;
  metadata?: Record<string, unknown>;
}
```

## Recommended Decision

Use this separation:

```txt
EventEnvelope
  What came in.

DetectorContext
  Common detector runtime context.

Source-specific context
  Readable source-level helper API.

DetectedEvent
  Business event that matched a detector.
```

This keeps EventKit source-agnostic while allowing detectors to be highly readable.
:::

---

## [43] User — 2026-06-26 01:44:28 UTC

Is this the thread where these were answered or was it another ?

    TypeScript details for EventEnvelope, DetectedEvent, JobExecution, HandlerContext, and run()

Run exists already in the original package we are rewriting for instance

---

## [44] Assistant (gpt-5-5) — 2026-06-26 01:44:29 UTC

This was **mostly another thread**.

In this thread, we progressively converged on the architecture and answered pieces of it:

- ✅ EventEnvelope responsibilities
- ✅ DetectorContext responsibilities
- ✅ Source-specific contexts (Hasura/Webhook/Cron)
- ✅ BatchJobs plugin architecture
- ✅ Lifecycle model
- ✅ Detector readability philosophy
- ✅ Plugin boundaries
- ✅ Event module architecture

However, we **did not fully design the runtime API** in this thread.

These are still only partially explored:

- `DetectedEvent` (we sketched it, but didn't finalize it)
- `HandlerContext`
- `JobContext`
- `JobExecution`
- `InvocationContext`
- `run()` API
- `job()` API
- How `run()` interacts with lifecycle hooks and plugins
- The shape of the handler return value

Those came from (or were started in) another conversation where we began thinking about EventKit as a complete runtime rather than just a detector framework.

---

I also think our thinking has evolved enough that I'd actually change part of what I proposed earlier.

For example, I no longer think `DetectedEvent` should necessarily contain the detector context:

```ts
detectorContext: TSourceContext
```

I think that's coupling the runtime model to the detector phase.

Instead I'd probably split it like this:

```txt
Invocation
    │
    ▼
EventEnvelope
    │
    ▼
DetectorContext
    │
detector()
    │
    ▼
DetectedEvent
    │
handler()
    │
    ▼
HandlerContext
    │
run(...)
    │
    ▼
JobExecution
```

Notice that **DetectorContext disappears after detection**.

The handler shouldn't care that Hasura had `columnChanged()`.

It only cares that:

```txt
Business event:
move.pickup.started
```

occurred.

Likewise, the `run()` function already exists in the current Hasura Event Detector and is one of the best abstractions in the package. I don't think it should disappear. Instead, I think it should become one of the core primitives of EventKit.

In fact, I'd argue **`run()` is more central than `job()`**.

Conceptually:

```ts
export const handler = async (event, ctx) => {
  return run(event, [
    job(updateTimeline),
    job(notifyDealer),
    job(createInvoice),
  ]);
};
```

still feels like exactly the right API.

The difference is that in EventKit:

- `run()` becomes the orchestrator of the unified execution lifecycle.
- `job()` becomes a declarative job definition.
- Plugins subscribe to the lifecycle emitted by `run()`.
- BatchJobs no longer wraps jobs because `run()` already emits everything it needs.

---

My recommendation is **not** to finalize those runtime types independently.

Instead, I think the next design document should be:

> **EventKit Runtime API**

That document should specify the complete runtime contract:

- `EventEnvelope`
- `DetectorContext`
- `DetectedEvent`
- `HandlerContext`
- `JobContext`
- `JobExecution`
- `run()`
- `job()`
- `JobResult`
- `InvocationResult`
- lifecycle events
- plugin hook signatures

Those types all depend on each other. Designing them together will produce a much cleaner API than defining them one at a time. I actually think this runtime API document is the last major architectural piece before the implementation work can begin.

---

## [45] User — 2026-06-26 01:45:33 UTC

Ok let’s design them here.

---

## [46] Assistant (gpt-5-5-thinking) — 2026-06-26 01:45:37 UTC

Yes. Let’s define the runtime types as one coherent API.

:::writing{variant="document" id="39184"}
# EventKit Runtime API Proposal

## Runtime Flow

```txt
Raw source payload
  -> SourceAdapter.normalize()
  -> EventEnvelope
  -> DetectorContext
  -> detector()
  -> DetectedEvent
  -> HandlerContext
  -> handler()
  -> run()
  -> JobExecution[]
```

## 1. EventEnvelope

`EventEnvelope` represents the normalized inbound source payload.

```ts
export interface EventEnvelope<
  TPayload = unknown,
  TMeta = Record<string, unknown>,
> {
  id: string;
  source: EventSourceName;
  sourceType: EventSourceType;
  receivedAt: Date;
  correlationId: string;

  payload: TPayload;
  meta: TMeta;
  raw?: unknown;
}
```

It answers: **what came into EventKit?**

It should not contain detector helpers.

## 2. DetectedEvent

`DetectedEvent` represents a business event that matched.

```ts
export interface DetectedEvent<
  TPayload = unknown,
  TMeta = Record<string, unknown>,
> {
  id: string;
  name: EventName;

  invocationId: string;
  correlationId: string;

  source: EventSourceName;
  sourceType: EventSourceType;

  detectedAt: Date;
  detectorDurationMs: number;

  envelope: EventEnvelope<TPayload, TMeta>;

  metadata?: Record<string, unknown>;
}
```

Important decision: `DetectedEvent` should **not** carry `DetectorContext`. Detector helpers are for detection only.

## 3. DetectorContext

```ts
export interface DetectorContext<
  TPayload = unknown,
  TSourceContext = unknown,
  TMeta = Record<string, unknown>,
> {
  eventName: EventName;

  invocationId: string;
  correlationId: string;

  envelope: EventEnvelope<TPayload, TMeta>;

  source: EventSourceName;
  sourceType: EventSourceType;

  sourceContext: TSourceContext;

  log: DetectorLogger;
  metadata: Record<string, unknown>;
}
```

Source adapters can extend this:

```ts
export interface HasuraDetectorContext<TNewRow, TOldRow = TNewRow>
  extends DetectorContext<HasuraEventPayload<TNewRow>> {
  operation: HasuraOperation;
  schema: string;
  table: string;

  oldRow: TOldRow | null;
  newRow: TNewRow | null;

  inserted(): boolean;
  updated(): boolean;
  deleted(): boolean;

  columnChanged(column: keyof TNewRow & string): boolean;
  columnAdded(column: keyof TNewRow & string): boolean;
  columnRemoved(column: keyof TOldRow & string): boolean;
}
```

## 4. HandlerContext

`HandlerContext` is what handlers receive after detection.

```ts
export interface HandlerContext<
  TPayload = unknown,
  TMeta = Record<string, unknown>,
> {
  invocationId: string;
  correlationId: string;

  event: DetectedEvent<TPayload, TMeta>;
  envelope: EventEnvelope<TPayload, TMeta>;

  source: EventSourceName;
  sourceType: EventSourceType;

  log: HandlerLogger;
  metadata: Record<string, unknown>;

  signal?: AbortSignal;
}
```

Handlers should not use detector-only helpers like `columnChanged()`. If handlers need source data, they use `ctx.envelope.payload` or source adapter-provided handler context extensions.

Example Hasura handler context:

```ts
export interface HasuraHandlerContext<TNewRow, TOldRow = TNewRow>
  extends HandlerContext<HasuraEventPayload<TNewRow>> {
  operation: HasuraOperation;
  oldRow: TOldRow | null;
  newRow: TNewRow | null;
}
```

## 5. job()

`job()` creates a declarative job definition.

```ts
export function job<
  TJobContext extends JobContext = JobContext,
  TResult = unknown,
>(
  fn: JobFunction<TJobContext, TResult>,
  options?: JobOptions,
): JobDefinition<TJobContext, TResult>;
```

Types:

```ts
export type JobFunction<
  TJobContext extends JobContext = JobContext,
  TResult = unknown,
> = (ctx: TJobContext) => Promise<TResult> | TResult;

export interface JobDefinition<
  TJobContext extends JobContext = JobContext,
  TResult = unknown,
> {
  name: JobName;
  fn: JobFunction<TJobContext, TResult>;
  options: JobOptions;
}
```

Options:

```ts
export interface JobOptions {
  name?: string;
  timeoutMs?: number;
  retries?: number;

  tags?: string[];
  metadata?: Record<string, unknown>;

  durable?: boolean | DurableJobOptions;

  continueOnFailure?: boolean;
}
```

## 6. JobContext

`JobContext` is passed into every job function.

```ts
export interface JobContext<
  TPayload = unknown,
  TMeta = Record<string, unknown>,
> {
  invocationId: string;
  correlationId: string;

  event: DetectedEvent<TPayload, TMeta>;
  envelope: EventEnvelope<TPayload, TMeta>;

  job: {
    id: string;
    name: JobName;
    attempt: number;
    options: JobOptions;
    metadata: Record<string, unknown>;
  };

  log: JobLogger;

  progress(value: number, metadata?: Record<string, unknown>): Promise<void>;
  checkpoint(name: string, metadata?: Record<string, unknown>): Promise<void>;

  signal?: AbortSignal;
}
```

Plugins may augment `JobContext`.

Example BatchJobs plugin:

```ts
export interface BatchJobContextExtension<TBatchRecord = unknown> {
  batchJob?: {
    id: string | number;
    record: TBatchRecord;
    status?: string;
  };
}
```

## 7. run()

`run()` is the core execution orchestrator.

It already exists conceptually in Hasura Event Detector and should remain central.

```ts
export async function run<
  TPayload = unknown,
  TMeta = Record<string, unknown>,
>(
  event: DetectedEvent<TPayload, TMeta>,
  jobs: JobDefinition[],
  options?: RunOptions,
): Promise<JobExecution[]>;
```

Options:

```ts
export interface RunOptions {
  mode?: 'parallel' | 'series';
  continueOnFailure?: boolean;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}
```

Responsibilities:

- Create job executions.
- Emit lifecycle hooks.
- Build `JobContext`.
- Apply timeout and retry rules.
- Collect results.
- Return `JobExecution[]`.
- Let plugins observe and augment execution.

`run()` should be where BatchJobs, Observability, Grafana, Sentry, and tracking plugins all integrate.

## 8. JobExecution

```ts
export interface JobExecution<TResult = unknown> {
  id: string;
  jobName: JobName;

  eventId: string;
  eventName: EventName;

  invocationId: string;
  correlationId: string;

  status: JobExecutionStatus;

  attempt: number;
  maxAttempts: number;

  startedAt: Date;
  completedAt?: Date;
  durationMs?: number;

  output?: TResult;
  error?: SerializedError;

  metadata: Record<string, unknown>;
}
```

```ts
export type JobExecutionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'timed_out'
  | 'cancelled';
```

## 9. HandlerFunction

```ts
export type HandlerFunction<
  THandlerContext extends HandlerContext = HandlerContext,
> = (
  event: DetectedEvent,
  ctx: THandlerContext,
) => Promise<JobExecution[]> | JobExecution[];
```

Example:

```ts
export const handler = async (event, ctx) => {
  return run(event, [
    job(updateTimeline),
    job(notifyDealer),
  ]);
};
```

## 10. EventModule

```ts
export interface EventModule<
  TDetectorContext extends DetectorContext = DetectorContext,
  THandlerContext extends HandlerContext = HandlerContext,
> {
  name: EventName;
  detector: DetectorFunction<TDetectorContext>;
  handler: HandlerFunction<THandlerContext>;
  metadata?: EventModuleMetadata;
}
```

```ts
export type DetectorFunction<
  TDetectorContext extends DetectorContext = DetectorContext,
> = (ctx: TDetectorContext) => boolean | Promise<boolean>;
```

## 11. Lifecycle Hooks

```ts
export interface EventKitPlugin {
  onInvocationStart?(ctx: InvocationContext): Promise<void> | void;
  onInvocationEnd?(ctx: InvocationContext, result: InvocationResult): Promise<void> | void;

  onEventDetectionStart?(ctx: DetectorContext): Promise<void> | void;
  onEventDetectionEnd?(ctx: DetectorContext, result: DetectionResult): Promise<void> | void;

  onEventHandlerStart?(ctx: HandlerContext): Promise<void> | void;
  onEventHandlerEnd?(ctx: HandlerContext, result: HandlerResult): Promise<void> | void;

  onJobStart?(ctx: JobContext): Promise<void> | void;
  onJobProgress?(ctx: JobContext, progress: JobProgress): Promise<void> | void;
  onJobCheckpoint?(ctx: JobContext, checkpoint: JobCheckpoint): Promise<void> | void;
  onJobLog?(ctx: JobContext, entry: LogEntry): Promise<void> | void;
  onJobEnd?(ctx: JobContext, execution: JobExecution): Promise<void> | void;

  onError?(ctx: ErrorContext): Promise<void> | void;
  flush?(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}
```

## 12. Example End-to-End Event

```ts
import { hasura } from '@hopdrive/eventkit-source-hasura';
import { job, run } from '@hopdrive/eventkit';
import { isStatusTimeChangeValid } from '../lib/move-detector-helpers';

export const detector = hasura.detector<MoveRow>((ctx) => {
  const moveWasUpdated =
    ctx.updated();

  const pickupStartedChanged =
    ctx.columnChanged('pickup_started');

  const pickupStartedWasSet =
    ctx.newRow?.pickup_started !== null;

  const pickupStartedTimestampIsValid =
    isStatusTimeChangeValid(
      ctx.newRow?.pickup_started,
      ctx.oldRow?.pickup_started,
    );

  return (
    moveWasUpdated &&
    pickupStartedChanged &&
    pickupStartedWasSet &&
    pickupStartedTimestampIsValid
  );
});

export const handler = async (event, ctx) => {
  return run(event, [
    job(updateMoveTimeline),
    job(notifyDealer),
  ]);
};
```

## 13. BatchJobs Example

```ts
import { hasura } from '@hopdrive/eventkit-source-hasura';
import { job, run } from '@hopdrive/eventkit';
import { batchJobs } from '@hopdrive/eventkit-plugin-batchjobs';

export const detector = hasura.detector<BatchJobRow>((ctx) => {
  const batchJobWasCreated =
    batchJobs.detector.created(ctx);

  const isArV2Batch =
    batchJobs.detector.triggerType(ctx, 'ar_v2');

  return (
    batchJobWasCreated &&
    isArV2Batch
  );
});

export const handler = async (event, ctx) => {
  return run(event, [
    job(runARBatchV2, {
      durable: batchJobs.record(ctx.newRow),
    }),
  ]);
};
```

## Core Decision Summary

```txt
EventEnvelope
  What came in.

DetectorContext
  What detector needs to decide if the business event occurred.

DetectedEvent
  The business event that was detected.

HandlerContext
  What handler needs to orchestrate jobs.

run()
  The job execution orchestrator.

JobContext
  What job needs while running.

JobExecution
  What happened when a job ran.
```
:::

---

