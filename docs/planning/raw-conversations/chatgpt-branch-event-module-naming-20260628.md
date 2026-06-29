# Branch - Event Module Naming

- **Source:** https://chatgpt.com/g/g-p-6a35712f5bf48191b053ab0cf5a46ba4/c/6a30e0bc-8d68-832e-9851-fe3585cbf2b4
- **Messages:** 45
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

## [3] Assistant — 2026-06-16 05:07:00 UTC

The output of this plugin was redacted.

---

## [4] Assistant — 2026-06-16 05:07:03 UTC

The output of this plugin was redacted.

---

## [5] Assistant — 2026-06-16 05:07:07 UTC

The output of this plugin was redacted.

---

## [6] Assistant — 2026-06-16 05:07:11 UTC

The output of this plugin was redacted.

---

## [7] Assistant (gpt-5-5-thinking) — 2026-06-16 05:07:15 UTC

I found the two core repos: `hopdrive/hasura-event-detector` and `hopdrive/event-handlers`. I’m going to sample their package structure, exported APIs, handler definitions, observability pieces, and batch job usage rather than attempting a full line-by-line audit.

---

## [8] Assistant — 2026-06-16 05:07:15 UTC

The output of this plugin was redacted.

---

## [9] Assistant — 2026-06-16 05:07:21 UTC

The output of this plugin was redacted.

---

## [10] Assistant — 2026-06-16 05:07:30 UTC

The output of this plugin was redacted.

---

## [11] Assistant — 2026-06-16 05:07:33 UTC

The output of this plugin was redacted.

---

## [12] Assistant — 2026-06-16 05:07:37 UTC

The output of this plugin was redacted.

---

## [13] Assistant — 2026-06-16 05:07:40 UTC

The output of this plugin was redacted.

---

## [14] Assistant — 2026-06-16 05:07:44 UTC

The output of this plugin was redacted.

---

## [15] Assistant — 2026-06-16 05:07:47 UTC

The output of this plugin was redacted.

---

## [16] Assistant — 2026-06-16 05:07:51 UTC

The output of this plugin was redacted.

---

## [17] Assistant — 2026-06-16 05:07:55 UTC

The output of this plugin was redacted.

---

## [18] Assistant — 2026-06-16 05:07:59 UTC

The output of this plugin was redacted.

---

## [19] Assistant — 2026-06-16 05:08:06 UTC

The output of this plugin was redacted.

---

## [20] Assistant — 2026-06-16 05:08:09 UTC

The output of this plugin was redacted.

---

## [21] Assistant — 2026-06-16 05:08:13 UTC

The output of this plugin was redacted.

---

## [22] Assistant — 2026-06-16 05:08:17 UTC

The output of this plugin was redacted.

---

## [23] Assistant — 2026-06-16 05:08:22 UTC

The output of this plugin was redacted.

---

## [24] Assistant — 2026-06-16 05:08:27 UTC

The output of this plugin was redacted.

---

## [25] Assistant — 2026-06-16 05:08:32 UTC

The output of this plugin was redacted.

---

## [26] Assistant — 2026-06-16 05:08:38 UTC

The output of this plugin was redacted.

---

## [27] Assistant — 2026-06-16 05:08:47 UTC

The output of this plugin was redacted.

---

## [28] Assistant — 2026-06-16 05:08:52 UTC

The output of this plugin was redacted.

---

## [29] Assistant — 2026-06-16 05:09:00 UTC

The output of this plugin was redacted.

---

## [30] Assistant (gpt-5-5-thinking) — 2026-06-16 05:09:04 UTC

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

## [31] User — 2026-06-16 05:37:17 UTC

I was always a fan of the simplicity of the event modules named what their event is using a standard dot notation with 3 segments further refining the event in each level from left to right. Then that module exports a detector and handler. The detector should be easy to read and right at the top of the event module code. When you open the move.pickup.started the detection logic should be front and center. The multiple items that go into the more complex combined should be defined individually with well named variables then the final return of detection Boolean read like a sentence of the combination of all named criteria variables. 

Look at how we build event detectors in the event handlers repo like in db-moves

---

## [32] Assistant (gpt-5-5-thinking) — 2026-06-16 05:37:19 UTC

That module style is worth preserving as a design constraint, not treating it as legacy. I’ll look specifically at the `db-moves` event detectors and then fold that pattern into the framework proposal.

---

## [33] Assistant (gpt-5-5-thinking) — 2026-06-16 05:37:54 UTC

Yes, that pattern should be the **primary authoring API**.

The repo already does this well:

```js
'move.pickup.started': require('./move.pickup.started')
```

from `db-moves/events/index.js`, where event names are explicit, discoverable, and module-backed. fileciteturn5file0

`move.pickup.started` also has the detector at the top, before the handler, and keeps the detector small: parse event, switch on operation, calculate named criteria, return the boolean. fileciteturn6file0

I’d make that the new framework’s convention:

```ts
export const detector = defineDetector(({ event }) => {
  const movePickupStartedChanged = event.hasChanged('pickup_started');

  const movePickupStartedWasSet =
    event.new.pickup_started !== null;

  const pickupStartedTimeChangeIsValid =
    isStatusTimeChangeValid(event.new.pickup_started, event.old.pickup_started);

  return (
    movePickupStartedChanged &&
    movePickupStartedWasSet &&
    pickupStartedTimeChangeIsValid
  );
});

export const handler = defineHandler(async ({ event, run }) => {
  return run([
    job(publishGenericWebhook),
    job(handleSMSInitiation),
    job(runAR),
  ]);
});
```

Or, even closer to your “reads like a sentence” preference:

```ts
return (
  movePickupStartedChanged &&
  movePickupStartedWasSet &&
  pickupStartedTimeChangeIsValid
);
```

The package should enforce this as a first-class convention:

```txt
events/
  move.pickup.started.ts
  move.pickup.arrived.ts
  move.pickup.successful.ts
  move.delivery.started.ts
```

And loading should stay name-based:

```ts
const events = loadEventsFromModules('./events');

await runtime.handle(payload, {
  events,
});
```

I’d avoid over-abstracting detectors into a fluent DSL if it hides intent. The framework should provide helpers, but the event module should still read like plain business logic.

Best compromise:

```ts
const pickupStartedChanged = db.columnChanged('pickup_started');
const pickupStartedWasSet = db.new.pickup_started !== null;
const pickupStartedTimeIsValid = isStatusTimeChangeValid(
  db.new.pickup_started,
  db.old.pickup_started,
);

return pickupStartedChanged && pickupStartedWasSet && pickupStartedTimeIsValid;
```

That keeps the HopDrive pattern intact while making Hasura only one source adapter.

---

## [34] User — 2026-06-16 05:50:24 UTC

The detector should load a type from the detector plugins. For instance a Hasura detector plugin should come with all of the utilities we’ve created for making the detector code read like a logical sentence. Using tools like columnChanged that would come from that plugin. A detector for Hasura would look a lot like they do today. Then other detectors might look different but I’d want the system to have a pattern that is the easiest structure of an event module that makes it easy to create the most readable code with detector logic front and center easy to read as soon as you open the module

---

## [35] Assistant (gpt-5-5-thinking) — 2026-06-16 05:50:26 UTC

Exactly. I’d make **detector plugin context** the core extension point.

```ts
export const detector = hasura.detector(({ columnChanged, newValue, oldValue }) => {
  const pickupStartedChanged = columnChanged('pickup_started');

  const pickupStartedWasSet =
    newValue('pickup_started') !== null;

  const pickupStartedTimeIsValid =
    isStatusTimeChangeValid(
      newValue('pickup_started'),
      oldValue('pickup_started'),
    );

  return (
    pickupStartedChanged &&
    pickupStartedWasSet &&
    pickupStartedTimeIsValid
  );
});
```

Then the event module stays simple:

```ts
import { hasura } from '@hopdrive/eventkit-plugin-hasura';

export const name = 'move.pickup.started';

export const detector = hasura.detector(({ db }) => {
  const pickupStartedChanged = db.columnChanged('pickup_started');
  const pickupStartedWasSet = db.new.pickup_started !== null;
  const pickupStartedTimeIsValid = isStatusTimeChangeValid(
    db.new.pickup_started,
    db.old.pickup_started,
  );

  return (
    pickupStartedChanged &&
    pickupStartedWasSet &&
    pickupStartedTimeIsValid
  );
});

export const handler = handler(({ run, event }) =>
  run([
    job(publishGenericWebhook),
    job(handleSMSInitiation),
    job(runAR),
  ])
);
```

The framework contract becomes:

```ts
type EventModule<TDetectorContext> = {
  name: EventName;
  detector: Detector<TDetectorContext>;
  handler: Handler;
};
```

Each detector plugin supplies its own readable context:

```ts
hasura.detector(ctx => boolean)
webhook.detector(ctx => boolean)
cron.detector(ctx => boolean)
app.detector(ctx => boolean)
batchJob.detector(ctx => boolean)
```

Examples:

```ts
export const detector = webhook.detector(({ payload, header, signature }) => {
  const eventIsOrderCreated = payload.type === 'order.created';
  const signatureIsValid = signature.valid;
  const customerIsKnown = Boolean(payload.customer_id);

  return eventIsOrderCreated && signatureIsValid && customerIsKnown;
});
```

```ts
export const detector = cron.detector(({ schedule, now }) => {
  const isDailyReconciliation = schedule.name === 'daily.reconciliation';
  const isAfterCutoff = now.hour >= 2;

  return isDailyReconciliation && isAfterCutoff;
});
```

This preserves the HopDrive authoring style:

1. The file name is the canonical event name.
2. Detector is at the top.
3. Detector reads as plain business logic.
4. Complex criteria are named individually.
5. The final return is a logical sentence.
6. Source-specific detector ergonomics come from plugins, not from core.

I’d make the new package opinionated about this with docs and lintable conventions:

```txt
event module order:
  1. imports
  2. event name
  3. detector
  4. handler
  5. private helpers
```

Core should not know what `columnChanged` means. The Hasura detector plugin should.

---

## [36] User — 2026-06-16 06:06:27 UTC

Can you show a few examples rewritten from event handlers with this new api?

---

## [37] Assistant (gpt-5-5) — 2026-06-16 06:06:28 UTC

Yes. Looking at the actual patterns in `event-handlers`, I'd lean into the readability even harder than the current implementation.

## Example 1: move.pickup.started

Current detector:

```js
const statusChanged = columnHasChanged('pickup_started', dbEvent);
const isThisEvent =
  dbEvent?.new?.pickup_started !== null &&
  isStatusTimeChangeValid(
    dbEvent?.new?.pickup_started,
    dbEvent?.old?.pickup_started
  );

return statusChanged && isThisEvent;
```

New version:

```ts
import { hasura } from '@hopdrive/eventkit-hasura';

export const name = 'move.pickup.started';

export const detector = hasura.detector(({ db }) => {
  const pickupStartedChanged =
    db.columnChanged('pickup_started');

  const pickupStartedWasSet =
    db.new.pickup_started !== null;

  const pickupStartedTimestampIsValid =
    isStatusTimeChangeValid(
      db.new.pickup_started,
      db.old.pickup_started,
    );

  return (
    pickupStartedChanged &&
    pickupStartedWasSet &&
    pickupStartedTimestampIsValid
  );
});

export const handler = moveHandler(async ({ db, jobs }) => {
  return jobs.run([
    job(publishGenericWebhook),
    job(handleSMSInitiation),
    job(runAR),
    job(runARV2),
  ]);
});
```

---

## Example 2: move.delivery.started

Current code is nearly identical but for `delivery_started`.

Instead of repeating detector plumbing:

```ts
import { moveTimestampEvent } from '@hopdrive/eventkit-hasura/move-events';

export const name = 'move.delivery.started';

export const detector = moveTimestampEvent({
  column: 'delivery_started',
});

export const handler = moveHandler(async ({ jobs }) => {
  return jobs.run([
    job(publishGenericWebhook),
    job(handleSMSInitiation),
  ]);
});
```

Internally:

```ts
export function moveTimestampEvent({
  column,
}: {
  column: keyof Move;
}) {
  return hasura.detector(({ db }) => {
    const timestampChanged =
      db.columnChanged(column);

    const timestampWasSet =
      db.new[column] !== null;

    const timestampIsValid =
      isStatusTimeChangeValid(
        db.new[column],
        db.old[column],
      );

    return (
      timestampChanged &&
      timestampWasSet &&
      timestampIsValid
    );
  });
}
```

That preserves readability while reducing duplication.

---

## Example 3: move.dispatched

Imagine a more complex detector.

Instead of:

```ts
export const detector = hasura.detector(({ db }) => {
  ...
});
```

I'd want:

```ts
export const detector = hasura.detector(({ db }) => {
  const driverChanged =
    db.columnChanged('driver_id');

  const driverAssigned =
    db.new.driver_id !== null;

  const moveIsNotCancelled =
    !db.new.cancel_status;

  const moveIsDispatchable =
    db.new.status === 'scheduled';

  return (
    driverChanged &&
    driverAssigned &&
    moveIsNotCancelled &&
    moveIsDispatchable
  );
});
```

When you open the file you immediately understand why the event exists.

---

## Example 4: reverse integration webhook

Today these are often modeled differently.

I'd unify them:

```ts
export const name = 'acertus.order.created';

export const detector = webhook.detector(({ payload }) => {
  const eventIsOrderCreated =
    payload.eventType === 'ORDER_CREATED';

  const orderIdExists =
    Boolean(payload.orderId);

  return (
    eventIsOrderCreated &&
    orderIdExists
  );
});

export const handler = async ({ payload, jobs }) => {
  return jobs.run([
    job(createMoveFromAcertusOrder),
    job(sendNotifications),
  ]);
};
```

Notice the module shape is identical.

Only the detector context changed.

---

## Example 5: Batch Job event

Instead of batchjobs being special:

```ts
export const name = 'batchjob.retry.requested';

export const detector = batchJobs.detector(({ job }) => {
  const jobFailed =
    job.status === 'failed';

  const retriesRemain =
    job.retryCount < job.maxRetries;

  return (
    jobFailed &&
    retriesRemain
  );
});

export const handler = async ({ job, jobs }) => {
  return jobs.run([
    runBatchJob(job.id),
  ]);
};
```

---

# One thing I'd add that doesn't exist today

I'd separate **detector source** from **event meaning**.

Today:

```txt
move.pickup.started
```

implicitly means Hasura.

In the new system:

```txt
move.pickup.started
```

is the business event.

The source becomes:

```ts
export const detector =
  hasura.detector(...);
```

or

```ts
export const detector =
  webhook.detector(...);
```

or

```ts
export const detector =
  batchJobs.detector(...);
```

So the event name remains stable while the mechanism that detects it is pluggable.

That's actually the biggest architectural improvement I see. The event module remains the center of the system, exactly as it is today, while Hasura becomes merely one way to detect that the business event occurred.

---

## [38] User — 2026-06-16 06:10:34 UTC

This is messy. You added move specific functionality to a general Hasura detector plugin. Moves are a table in the HopDrive data model not a general concept in Hasura

---

## [39] Assistant (gpt-5-5-thinking) — 2026-06-16 06:10:36 UTC

You’re right. That was the wrong boundary.

The **Hasura detector plugin** should only know Hasura concepts:

```ts
hasura.detector(({ operation, table, oldRow, newRow, columnChanged }) => {
  const isUpdateOperation = operation === 'UPDATE';
  const isMovesTable = table.name === 'moves';
  const pickupStartedChanged = columnChanged('pickup_started');
  const pickupStartedWasSet = newRow.pickup_started !== null;

  return (
    isUpdateOperation &&
    isMovesTable &&
    pickupStartedChanged &&
    pickupStartedWasSet
  );
});
```

Anything move-specific belongs in the **event module**, app code, or a HopDrive-specific helper library, not the generic plugin.

Better separation:

```txt
@hopdrive/eventkit
@hopdrive/eventkit-source-hasura
@hopdrive/eventkit-plugin-observability
@hopdrive/eventkit-plugin-batchjobs

event-handlers/
  lib/event-helpers/move-status-events.ts
  functions/db-moves/events/move.pickup.started.ts
```

So a reusable HopDrive helper could exist in `event-handlers`, not in Hasura:

```ts
function moveTimestampWasSet({
  column,
  newRow,
  oldRow,
  columnChanged,
}: HasuraDetectorContext<'moves'>) {
  const timestampChanged = columnChanged(column);
  const timestampWasSet = newRow[column] !== null;
  const timestampChangeIsValid = isStatusTimeChangeValid(
    newRow[column],
    oldRow[column],
  );

  return (
    timestampChanged &&
    timestampWasSet &&
    timestampChangeIsValid
  );
}
```

Then the event remains readable:

```ts
export const detector = hasura.detector<'moves'>((ctx) => {
  const isMoveUpdate =
    ctx.operation === 'UPDATE' &&
    ctx.table.name === 'moves';

  const pickupStartedWasDetected =
    moveTimestampWasSet({
      column: 'pickup_started',
      ...ctx,
    });

  return (
    isMoveUpdate &&
    pickupStartedWasDetected
  );
});
```

General plugin provides primitives. HopDrive app code composes them into domain language.

---

## [40] User — 2026-06-16 13:38:32 UTC

Yeah that’s better. Write me a brief summary of our decisions so we can hand it back upstream to the parent branch of this conversation

---

## [41] Assistant (gpt-5-5) — 2026-06-16 13:38:33 UTC

:::writing{variant="document" id="58241"}
# Event Framework Rewrite - Architectural Decisions

## Core Direction

The current Hasura Event Detector should evolve into a general event detection, event handling, async job, and observability framework.

Hasura becomes the first source adapter, not the central abstraction of the framework.

The framework should support:

- Hasura database events
- Generic webhook events
- Cron/scheduled events
- Application-generated events
- Batch job events
- Future event sources

while preserving the event authoring experience that exists today in `event-handlers`.

---

## Event Modules Remain the Center of the System

The existing event module pattern is a major strength and should be preserved.

Events continue to be defined as individual modules named after the business event:

```txt
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

The detector remains at the top of the file and should be the first thing developers see when opening the module.

---

## Detector Readability is a Primary Design Goal

Detector code should read like a logical sentence.

Complex criteria should be assigned to well-named variables.

The final return statement should clearly express the business logic.

Example:

```ts
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
```

The framework should optimize for readability first.

---

## Detector Plugins Provide Context and Utilities

Detector plugins are responsible for exposing source-specific context and helper functions.

Example:

```ts
export const detector = hasura.detector((ctx) => {
  ...
});
```

The Hasura plugin may provide:

```ts
operation
table
oldRow
newRow
columnChanged()
columnAdded()
columnRemoved()
```

and other Hasura-specific helpers.

The core framework should not know about Hasura concepts.

---

## Domain Logic Does Not Belong in Source Plugins

Source plugins should only expose source-level concepts.

Bad:

```txt
Hasura plugin contains move-specific helpers
Hasura plugin contains HopDrive business rules
```

Good:

```txt
Hasura plugin contains columnChanged()
Hasura plugin contains row access helpers
Hasura plugin contains operation helpers
```

Move-specific helpers belong in HopDrive application code.

Example:

```txt
event-handlers/
  lib/
    move-detector-helpers/
```

not inside the framework.

---

## Business Events Are Independent From Event Sources

The event name represents a business event.

The detector source is implementation detail.

Example:

```txt
move.pickup.started
```

is the business event.

Detection may come from:

```ts
hasura.detector(...)
```

or

```ts
webhook.detector(...)
```

or

```ts
batchJob.detector(...)
```

without changing the event identity.

This separation is a key architectural goal.

---

## Batch Jobs Should Become a First-Class Plugin

Current batch jobs are built on top of the event framework.

The next version should treat batch jobs as a plugin rather than a special subsystem.

Responsibilities:

- execution tracking
- retries
- exception trapping
- state persistence
- lifecycle events
- observability integration

The framework should provide generic job execution primitives while the batch job plugin handles persistence and state management.

---

## Observability and Console

Observability should be promoted to a first-class package.

The console should be organized alongside observability rather than feeling attached to Hasura.

Potential package structure:

```txt
eventkit/
eventkit-source-hasura/
eventkit-source-webhook/
eventkit-plugin-observability/
eventkit-plugin-batchjobs/
eventkit-console/
```

---

## Guiding Principle

Source adapters normalize incoming events.

Event modules define business events.

Handlers execute business behavior.

Plugins augment execution (observability, tracking, retries, state management, etc.).

The event module remains the primary authoring experience and the most important abstraction in the system.
:::

---

## [42] User — 2026-06-26 00:49:53 UTC

Write a single snippet of text I copy at once that describes everything we covered in this thread

---

## [43] Assistant (gpt-5-5) — 2026-06-26 00:49:54 UTC

:::writing{variant="document" id="84726"}
The rewrite should evolve Hasura Event Detector into a general event framework where Hasura is simply the first supported event source rather than the defining abstraction. The framework should support multiple event sources including Hasura database events, generic webhooks from any vendor, cron/scheduled events, application-generated events, batch job events, and future adapters. The current event authoring model from `event-handlers` is one of the strongest parts of the existing architecture and should be preserved. Events continue to be individual modules named after the business event using dot notation (e.g. `move.pickup.started`, `move.delivery.arrived`, `acertus.order.created`), with each module exporting a `detector` and a `handler`. The detector should always appear at the top of the module so that opening the file immediately reveals the event's detection logic.

A primary design goal is detector readability. Detector code should read like business rules rather than framework plumbing. Complex conditions should be broken into individually named boolean variables, and the final return statement should read like a logical sentence composed of those variables. The framework should optimize for this style above all else.

The framework should introduce detector plugins. Rather than every detector receiving the same generic context, each event source provides a specialized detector context with utilities appropriate for that source. For example, the Hasura detector plugin would expose concepts such as the operation, table metadata, old and new row values, and helpers like `columnChanged()`, `columnAdded()`, and other Hasura-specific utilities. Webhook, cron, application, and batch job detectors would expose different contexts appropriate to those event sources while maintaining the same overall event module structure.

It is important that detector plugins remain generic. The Hasura plugin should know only about Hasura concepts and must never contain HopDrive-specific business logic. Helpers relating to moves, drivers, workflows, or other application concepts belong in the application codebase, not inside the framework. If common detector helpers emerge for the HopDrive domain (for example, reusable move detection helpers), they should live in the `event-handlers` repository or another HopDrive package layered on top of the generic framework rather than inside the Hasura adapter.

The event name represents the business event, while the detector plugin represents how that event is discovered. This separates business semantics from transport or source. A business event such as `move.pickup.started` should be able to be detected from a Hasura event today or potentially another event source in the future without changing the event's identity.

The current async job system should become a first-class plugin within the new framework. The framework should provide generic job execution primitives, while the batch job plugin is responsible for persistence, retries, exception trapping, lifecycle state management, and integration with observability. Likewise, the observability system and console should become first-class packages rather than remaining tied to Hasura-specific naming or organization.

Overall, the architecture should clearly separate responsibilities: source adapters normalize incoming events and expose source-specific detector APIs; event modules define business events and their detection logic; handlers execute business behavior; and plugins augment execution with capabilities such as observability, tracking, retries, state management, and other cross-cutting concerns. Throughout the redesign, the event module remains the primary authoring experience and should continue to be the most readable and important abstraction in the system.
:::

---

## [44] User — 2026-06-26 01:43:11 UTC

Is it this chat thread that knows the answers to this or maybe another?

    TypeScript details for EventEnvelope, DetectedEvent, JobExecution, HandlerContext, and run(

---

## [45] Assistant (gpt-5-5) — 2026-06-26 01:43:13 UTC

This thread has **part** of it, but not the full answer.

This thread established the **authoring model** and the architectural boundaries:

- Event modules are the primary abstraction.
- Detectors come first and should be highly readable.
- Detector plugins provide source-specific APIs (Hasura, webhook, cron, etc.).
- Business logic stays out of source adapters.
- Event names represent business events, independent of how they're detected.
- Batch jobs and observability become plugins.

However, we **did not** fully design the runtime types here.

The types you listed:

- `EventEnvelope`
- `DetectedEvent`
- `JobExecution`
- `HandlerContext`
- `run()`

were mostly discussed in the **parent conversation**, especially around your proposal for `EventEnvelope` and `DetectorContext`. I also recall we started talking about making `run()` more than just a job executor, but we didn't finish that design in this branch.

If I were reconstructing where each concept belongs:

| Type | Where it was primarily discussed |
|-------|----------------------------------|
| `EventEnvelope` | Parent conversation (we defined responsibilities) |
| `DetectorContext` | Parent conversation, then refined here into plugin-specific contexts |
| `DetectedEvent` | Mostly parent conversation, not fleshed out here |
| `HandlerContext` | Barely discussed here, mostly parent |
| `JobExecution` | Mostly parent and batch job discussions |
| `run()` | Mentioned here only in examples, not actually designed |

So I'd treat this branch as the **event authoring API discussion**, while the parent thread contains the **runtime execution model**.

I also think there's one architectural insight that only became clear after this discussion:

> The runtime should expose four progressively richer layers:
>
> 1. **Source adapter** → produces an `EventEnvelope`.
> 2. **Detector plugin** → turns an `EventEnvelope` into a typed detector context and decides whether a business event occurred.
> 3. **Event module** → declares the business event via a detector and a handler.
> 4. **Execution runtime** → executes handlers, jobs, plugins, observability, retries, and batch state.

That layering wasn't explicit before, and I think it ties the parent conversation and this branch together cleanly.

---

