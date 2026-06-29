# EventKit Architecture RFC original google doc this MD was exported from

https://docs.google.com/document/d/18Qk0-fufGjF-46hPvLR-wF7Iq-QJ5vdyY4-F5_odgtI/edit?usp=sharing

# EventKit Architecture RFC

## Canonical Living Specification

Status: Living Draft
Owner: HopDrive Engineering
Document Purpose: This document is the canonical architecture specification for EventKit. It records agreed decisions, rationale, examples, implementation guidance, and future considerations. It should be updated whenever meaningful architecture decisions are made.

# Why EventKit Exists

#

EventKit is one of the foundational abstractions that HopDrive intends to build upon for the next decade. It standardizes how business events are discovered, executed, observed, documented, and reasoned about by both humans and AI agents.

#

Its purpose is not simply to replace the Hasura Event Detector. That migration is the immediate forcing function, but not the strategic endpoint. EventKit establishes a stable architectural language that can survive changes to infrastructure, event sources, deployment environments, execution models, and developer tooling.

#

The existing Hasura Event Detector proved that HopDrive benefits from naming business events explicitly and authoring detection logic in readable event modules. EventKit preserves that strength while removing the assumption that Hasura is the center of the event architecture. In the long term, HopDrive business behavior should be expressed in terms of business events, handlers, jobs, flows, and observations rather than in terms of whichever infrastructure component happened to deliver the original signal.

#

This matters because HopDrive workflows increasingly span databases, APIs, webhooks, scheduled jobs, application events, background jobs, third-party integrations, and AI-assisted operational tooling. Without a shared event language, the architecture becomes difficult to reason about, difficult to test, difficult to observe, and difficult for future engineers or AI agents to safely modify.

#

EventKit is intended to become that shared language. It should make business workflows more understandable, implementation changes less risky, runtime behavior easier to diagnose, and architecture knowledge easier to preserve over time.

#

# How to Use This Document

This document is intended to be maintained over time rather than completed in a single pass. Each major section should eventually contain:

\- Normative requirements using MUST, SHOULD, MAY language.
\- Rationale explaining why the decision exists.
\- Examples that show how the design is used.
\- Alternatives considered, especially for major architectural decisions.
\- AI Summary blocks that can be copied into future chats or implementation prompts.

# Document Status

This RFC currently reflects the consolidated EventKit design produced across project discussions. It should be treated as the source of truth unless later amended in this document.

# Revision History

| Date | Version | Author | Summary |
|---|---:|---|---|
| 2026-06-25 | 0.1 | ChatGPT \+ HopDrive | Created living RFC shell from consolidated EventKit design. |

# 1\. Executive Summary

EventKit is the source-agnostic evolution of HopDrive's Hasura Event Detector. The original Hasura Event Detector solved an important problem: it allowed HopDrive engineers to express business events as readable event modules instead of burying detection rules inside generic webhook handlers, database triggers, or background job orchestration code. That authoring model remains one of the strongest parts of the existing architecture and MUST be preserved.

The rewrite is not intended to discard the current event authoring experience. Instead, it generalizes the runtime around it. In the current model, Hasura database events are effectively the center of the framework. In EventKit, Hasura becomes one source adapter among several possible adapters. This distinction is fundamental. EventKit is not a Hasura abstraction. EventKit is a business-event abstraction with Hasura as the first supported source.

EventKit exists to answer three questions consistently:

1\. What came into the system?
2\. What business event did it represent?
3\. What work ran because of that business event?

Those questions map directly to the runtime vocabulary:

\- EventEnvelope answers what came in.
\- DetectedEvent answers what business event was detected.
\- JobExecution answers what work ran because of it.

The framework MUST preserve a clean separation between source mechanics, business detection, execution, durability, and observability. Source adapters normalize inbound payloads and expose source-specific detector helpers. Event modules express business event detection and handling. Handlers orchestrate jobs. The run() function executes jobs. Plugins observe or augment lifecycle behavior. BatchJobs provides durable execution support. Observability records runtime evidence. Flow Manifests describe expected business-process behavior. The Console visualizes expected behavior, observed behavior, and differences between the two.

The most important developer experience is the event module. A developer opening an event module should immediately see the business detection logic. The detector MUST appear at or near the top of the module. Detector code SHOULD read like a set of named business facts followed by a final boolean expression. Framework plumbing should be hidden behind source-specific detector helpers.

A business event name represents the domain event, not the transport. For example, move.pickup.started represents a business fact. It does not mean Hasura detected it, a webhook detected it, or a cron job detected it. Source adapters describe how an event was discovered. Event names describe what happened.

This design makes EventKit useful beyond a single migration project. It becomes the execution framework for event-driven business behavior and the foundation for architecture-as-code tooling. Over time, EventKit should help engineers and AI agents answer questions such as:

\- What business events exist?
\- What triggers this workflow?
\- Which jobs run when this event is detected?
\- Which source adapters can invoke this runtime?
\- Which runtime paths are expected?
\- What actually happened for a specific transaction?
\- Did the observed execution match the expected business process?

EventKit's long-term value is not only in executing events. Its value is in making business workflows understandable, observable, testable, and evolvable.

# 2\. Goals and Non-Goals

## 2.1 Primary Goals

EventKit MUST generalize the existing Hasura Event Detector into a source-agnostic event execution framework. The framework must support Hasura database events without making Hasura the central abstraction.

EventKit MUST preserve the current event module authoring model. Event modules continue to be named after business events using dot notation, such as move.pickup.started, move.delivery.arrived, and acertus.order.created. Each event module MUST export a detector and a handler.

EventKit MUST optimize detector readability. Detector code should look like business rules, not infrastructure code. Complex conditions SHOULD be assigned to named boolean variables. The final return expression SHOULD clearly communicate the business condition being detected.

EventKit MUST support source adapters. Source adapters normalize inbound payloads and create source-specific detector contexts. Initial source adapter categories include Hasura, webhook, cron, application-generated, queue, manual, and future adapters.

EventKit MUST keep the framework domain-agnostic. EventKit core, source adapters, and generic plugins MUST NOT contain HopDrive-specific business rules. Helpers related to moves, drivers, dealers, workflows, AR, notifications, or other HopDrive concepts belong in HopDrive application packages.

EventKit MUST make BatchJobs a first-class plugin for durability. BatchJobs is not a source adapter. It is responsible for persistence, retry history, delayed execution, state transitions, and durable job execution support.

EventKit MUST make Observability a first-class plugin. Observability captures invocation records, event detection records, handler records, job execution records, logs, progress events, checkpoints, errors, timings, correlation IDs, and chained invocations.

EventKit SHOULD support Flow Manifests as architecture-as-code artifacts. Flow Manifests describe expected business-process behavior and allow CI, tooling, and the Console to compare expected behavior against observed runtime behavior.

EventKit SHOULD provide a Console capable of viewing Expected Flow, Observed Flow, and Compare Mode. Expected Flow shows design-time process contracts. Observed Flow shows runtime evidence. Compare Mode overlays observed execution onto expected behavior.

## 2.2 Secondary Goals

EventKit SHOULD improve AI-assisted development by producing a stable, machine-readable architecture surface. Future AI agents should be able to inspect flow metadata, event metadata, job metadata, and observability traces without reverse-engineering hundreds of files.

EventKit SHOULD support incremental migration from the existing Hasura Event Detector. Existing event modules should move with minimal changes where possible.

EventKit SHOULD allow applications to register only the sources and plugins they need. Optional capabilities should be available through subpath exports from @hopdrive/eventkit rather than separate packages.

EventKit SHOULD support testing at multiple levels: detector unit tests, source adapter integration tests, handler/job tests, plugin lifecycle tests, flow manifest validation, and end-to-end workflow tests.

## 2.3 Non-Goals

EventKit is not a workflow engine. It does not attempt to model every possible branch, compensation step, long-running transaction, or human approval process as a durable workflow graph. It detects business events and runs jobs.

EventKit is not a BPMN engine. It does not attempt to implement BPMN semantics, swimlanes, gateways, message events, subprocesses, or graphical workflow authoring.

EventKit is not a distributed transaction coordinator. It does not guarantee atomicity across external systems. Jobs may fail, retry, or partially complete. Application code remains responsible for idempotency and safe side effects.

EventKit is not an ORM. Source adapters may expose source payloads and helper utilities, but EventKit does not own database access patterns, entity models, or persistence abstractions outside its own runtime metadata.

EventKit is not the owner of HopDrive business logic. Domain helpers belong in application packages layered above EventKit.

EventKit is not required to block runtime execution when expected and observed flows differ. Flow comparison is an observability, validation, and CI concern, not a production execution gate.

# 3\. Design Principles

## 3.1 Business Events Are the Primary Abstraction

The event module is the center of the developer experience. Business events are named according to domain meaning. Source adapters describe how data enters the system, but business events describe what the system believes happened.

A source-specific event name such as hasura.moves.updated.pickup\_started.changed would be a poor EventKit event name because it encodes the transport and detection mechanism. A business event such as move.pickup.started is preferred because it represents the domain fact that matters to application behavior.

## 3.2 Detectors Must Be Readable

Detector readability is a first-order requirement, not a cosmetic preference. The detector is often the only place where the exact business condition for an event is visible. If the detector is difficult to read, the business event becomes difficult to trust.

### Preferred style:

const moveWasUpdated \= ctx.updated();
const pickupStartedChanged \= ctx.columnChanged('pickup\_started');
const pickupStartedWasSet \= ctx.newRow?.pickup\_started \!== null;
const pickupStartedTimestampIsValid \= isStatusTimeChangeValid(
  ctx.newRow?.pickup\_started,
  ctx.oldRow?.pickup\_started,
);

return (
  moveWasUpdated &&
  pickupStartedChanged &&
  pickupStartedWasSet &&
  pickupStartedTimestampIsValid
);

### Discouraged style:

return ctx.updated() && ctx.columnChanged('pickup\_started') && ctx.newRow?.pickup\_started \!== null && isStatusTimeChangeValid(ctx.newRow?.pickup\_started, ctx.oldRow?.pickup\_started);

The discouraged version may be shorter, but it is less reviewable and less useful as executable business documentation.

## 3.3 Frameworks Must Stay Generic

EventKit core knows about invocations, envelopes, detectors, handlers, jobs, plugins, and lifecycle events. It does not know what a move, dealer, driver, repair order, mobility run, or AR batch is.

The Hasura adapter knows about Hasura operations, schemas, tables, old rows, new rows, and column changes. It does not know about HopDrive move status rules.

The BatchJobs plugin may know about durable job records and batch job lifecycle. It does not own Hasura parsing and does not own HopDrive business logic.

Application packages own domain semantics.

## 3.4 Explicit Registration Is Required

Event modules MUST be explicitly registered. This decision favors determinism over magic. Dynamic discovery can be attractive in local Node environments, but it introduces packaging ambiguity in serverless environments such as Netlify functions. Explicit registration ensures the bundler sees the dependencies and packages the correct modules.

### Example:

createEventKit({
  sources: \[hasura()\],
  plugins: \[observability(), batchJobs()\],
  events: \[
    movePickupStarted,
    moveDeliveryArrived,
    acertusOrderCreated,
  \],
});

## 3.5 One Detector Per Event Module

Each event module MUST export exactly one detector. This keeps the file focused and preserves the existing authoring model. The design intentionally does not support an array of detectors per event module.

If a future source needs to detect a related event, the implementation should create a separate event module or revisit the design only after a concrete need exists. The current design optimizes for simplicity, readability, observability, and tooling.

## 3.6 Plugins Extend Infrastructure, Not Business Logic

Plugins receive lifecycle callbacks and may augment runtime context. They should provide infrastructure capabilities such as observability, durability, tracing, metrics, audit logging, error capture, or operational tracking.

Plugins MUST NOT be used to hide business detection logic. Business detection belongs in detectors. Business execution belongs in handlers and jobs.

## 3.7 Expected Flow and Observed Flow Are Separate Truths

Expected Flow describes intended behavior. Observed Flow describes runtime behavior. Neither replaces the other. A declared expected flow may be stale. A runtime observed flow may include unexpected behavior. Compare Mode exists to reconcile both and classify differences.

# 4\. Terminology

## Invocation

An Invocation is a single inbound execution initiated by a source adapter. A Hasura trigger delivery creates an invocation. A webhook request creates an invocation. A cron tick creates an invocation. An application-emitted event creates an invocation. An invocation has one EventEnvelope and may result in zero, one, or many detected business events depending on registered event modules.

## EventEnvelope

An EventEnvelope is the normalized representation of what came into EventKit. It includes source identity, source type, received time, correlation ID, payload, metadata, and optionally the raw inbound payload. It is source-agnostic and must not expose source-specific helpers such as columnChanged().

## DetectorContext

DetectorContext is the context passed to a detector. It includes common EventKit runtime fields and a source-specific helper API. For Hasura, the detector context includes helpers such as inserted(), updated(), deleted(), columnChanged(), oldRow, and newRow. For webhooks, it may include method, headers, vendor, and eventType. For cron, it may include scheduleName and scheduledAt.

## DetectedEvent

DetectedEvent is created when a detector returns true. It represents a normalized business event. It includes the business event name, invocation ID, correlation ID, source, source type, detected time, detector duration, envelope, and optional metadata. It does not carry DetectorContext because detector helpers are detection-only.

## HandlerContext

HandlerContext is passed to the event handler after detection. It includes the DetectedEvent, EventEnvelope, source identity, correlation data, metadata, logger, and abort signal. It may include source-specific handler extensions, but it should not include detector-only helpers such as columnChanged().

## Job

A Job is a unit of work executed because of a detected event. Jobs should be focused and reusable. Examples include updateMoveTimeline, notifyDealer, publishEventLog, sendDriverPushNotification, createCustomerSmsMessage, and runARBatchV2.

## JobExecution

JobExecution is the result record for a job execution attempt. It includes job name, event ID, event name, invocation ID, correlation ID, status, attempt, max attempts, timing, output, error, and metadata.

## Plugin

A plugin is a lifecycle extension. Plugins receive callbacks as EventKit processes invocations, detects events, runs handlers, executes jobs, records progress, records checkpoints, logs, errors, flushes, and shuts down.

## Flow Manifest

A Flow Manifest is a source-controlled business-process contract. It describes expected nodes, edges, required branches, optional branches, conditions, terminal conditions, ownership, and operational notes.

# 5\. Architecture Overview

EventKit is intentionally layered so that each responsibility has a single owner. Every inbound request enters through a Source Adapter. The adapter constructs an EventEnvelope and an appropriate DetectorContext before passing control to the runtime. The runtime evaluates every registered event module. Each detector independently decides whether its business event occurred. Positive detections produce DetectedEvent objects, which are then dispatched to handlers. Handlers orchestrate one or more jobs. Jobs execute through the shared runtime so plugins receive consistent lifecycle callbacks regardless of the job implementation.

Plugins surround the runtime without owning it. They observe invocations, detections, handler execution, job execution, retries, failures, checkpoints, logging, and shutdown. This allows durability, tracing, metrics, auditing, and debugging capabilities to evolve independently of business logic.

The runtime guarantees a deterministic execution order. Source normalization always occurs before detection. Detection always completes before handlers begin. Handler orchestration completes before job execution finishes. Plugin callbacks are ordered consistently so observability data always reflects the actual execution sequence.

Errors are isolated whenever possible. A detector failure affects only that detector. One failing event module must not prevent unrelated event modules from evaluating unless execution is explicitly configured to fail fast. Likewise, job failures should be isolated from other jobs whenever practical, with retry policy delegated to the durability plugin.

# 6\. Runtime Lifecycle

Every invocation follows the same lifecycle regardless of source.

### Step 1: Receive inbound payload.

The source adapter receives a source-specific payload such as a Hasura event, webhook request, scheduled execution, queue message, or application event.

### Step 2: Normalize.

The adapter validates and normalizes the inbound payload into an EventEnvelope while constructing the appropriate DetectorContext.

### Step 3: Invoke plugins.

Plugins receive an invocation-start callback. Metrics, tracing, and logging plugins typically begin timing here.

### Step 4: Evaluate detectors.

Each registered detector executes independently using the DetectorContext. Detector execution time should be recorded individually. A detector returns either true or false. Returning true creates a DetectedEvent.

### Step 5: Execute handlers.

Each detected event invokes its handler. The handler should remain lightweight, primarily coordinating jobs rather than containing large amounts of business logic.

### Step 6: Execute jobs.

Jobs execute through run(). The runtime records start time, completion time, retries, failures, cancellation, checkpoints, progress updates, and outputs.

### Step 7: Finalize.

Plugins receive completion callbacks. Observability data is flushed. Durability state is updated. The invocation finishes with a complete execution record suitable for debugging and replay analysis.

# 7\. Source Adapter Contract

Every source adapter must implement the same conceptual contract. It must identify incoming work, normalize source-specific payloads, create an EventEnvelope, construct a DetectorContext, and invoke the runtime.

Adapters own translation but never business interpretation. For example, the Hasura adapter knows whether an UPDATE operation occurred, but it does not know whether that UPDATE represents a pickup beginning or a delivery completing. That interpretation belongs exclusively to event modules.

Adapters may expose convenience helpers that dramatically improve detector readability. Those helpers should express source semantics rather than application semantics. For example, columnChanged(), inserted(), updated(), deleted(), previousValue(), currentValue(), and operation() are appropriate Hasura helpers. Helpers such as movePickedUp() or dealerAcceptedOrder() are not appropriate because they encode application rules

# 8\. Detector API and Event Module Authoring

The detector API is the most important day-to-day developer-facing API in EventKit. The framework MUST make the common case easy, readable, and difficult to misuse. A detector is not a generic event callback. A detector is a business-rule predicate. It answers one question: did this business event occur for this invocation?

Every event module MUST have exactly one detector. The detector MUST be exported from the module and SHOULD appear before the handler so that opening the file immediately reveals the detection logic. This convention matters because event modules are intended to be executable documentation. A reviewer should be able to inspect an event module and understand the business condition without searching through framework setup code.

The detector function receives a DetectorContext. The base context includes EventKit runtime fields such as eventName, invocationId, correlationId, envelope, source, sourceType, metadata, and log. Source adapters extend this with source-specific helpers. For Hasura, the context includes operation, schema, table, oldRow, newRow, inserted(), updated(), deleted(), columnChanged(), columnAdded(), and columnRemoved(). For webhooks, the context includes HTTP method, headers, vendor metadata, body, and event type. For cron, the context includes schedule name, scheduled timestamp, and timezone.

Detector functions MUST return a boolean or Promise\<boolean\>. A truthy result means the business event occurred and EventKit should create a DetectedEvent. A false result means the event module did not match this invocation. Detectors SHOULD avoid side effects. They should not send notifications, mutate databases, enqueue jobs, publish analytics, or call external systems. Those actions belong in handlers and jobs.

### Preferred detector style uses named boolean variables:

export const detector \= hasura.detector\<MoveRow\>((ctx) \=\> {
  const moveWasUpdated \= ctx.updated();
  const pickupStartedChanged \= ctx.columnChanged('pickup\_started');
  const pickupStartedWasSet \= ctx.newRow?.pickup\_started \!== null;
  const pickupStartedTimestampIsValid \= isStatusTimeChangeValid(
    ctx.newRow?.pickup\_started,
    ctx.oldRow?.pickup\_started,
  );

  return (
    moveWasUpdated &&
    pickupStartedChanged &&
    pickupStartedWasSet &&
    pickupStartedTimestampIsValid
  );
});

The final return statement SHOULD read like a logical sentence. This is preferable to compact inline expressions because it makes code review, debugging, AI reasoning, and future maintenance easier.

The framework SHOULD provide test helpers that allow detectors to be tested without invoking the full runtime. Detector tests should construct representative source contexts and assert that the detector returns true or false for specific edge cases. For Hasura detectors, tests should cover INSERT, UPDATE, DELETE, unchanged columns, null-to-value transitions, value-to-null transitions, manual invocation, and malformed payloads.

Event names MUST be business-semantic names. They SHOULD use dot notation and SHOULD be stable over time. Renaming an event is a breaking architectural change because observability records, Flow Manifests, tests, and downstream consumers may depend on the event name.

Event module file naming SHOULD match the event name where practical. For example, move.pickup.started should be authored in a module that clearly maps to that name. The exact path structure MAY vary by repository, but the event name must remain the stable identity.

# 9\. Runtime API

EventKit exposes a small public runtime API. The public API exists to configure the framework, define jobs, run jobs, implement source adapters, implement plugins, and type event modules. The public API MUST remain stable enough for application code and extensions to depend on it.

The core runtime pipeline is:

Raw source payload
  \-\> SourceAdapter.normalize()
  \-\> EventEnvelope
  \-\> DetectorContext
  \-\> detector()
  \-\> DetectedEvent
  \-\> HandlerContext
  \-\> handler()
  \-\> run()
  \-\> JobExecution\[\]

EventEnvelope represents what came into EventKit. It is the normalized inbound source payload.

export interface EventEnvelope\<
  TPayload \= unknown,
  TMeta \= Record\<string, unknown\>,
\> {
  id: string;
  source: EventSourceName;
  sourceType: EventSourceType;
  receivedAt: Date;
  correlationId: string;
  payload: TPayload;
  meta: TMeta;
  raw?: unknown;
}

DetectedEvent represents the business event produced by a matching detector. It intentionally does not carry DetectorContext. Detector helpers are for detection only.

export interface DetectedEvent\<
  TPayload \= unknown,
  TMeta \= Record\<string, unknown\>,
\> {
  id: string;
  name: EventName;
  invocationId: string;
  correlationId: string;
  source: EventSourceName;
  sourceType: EventSourceType;
  detectedAt: Date;
  detectorDurationMs: number;
  envelope: EventEnvelope\<TPayload, TMeta\>;
  metadata?: Record\<string, unknown\>;
}

DetectorContext represents what a detector needs to decide whether the business event occurred.

export interface DetectorContext\<
  TPayload \= unknown,
  TSourceContext \= unknown,
  TMeta \= Record\<string, unknown\>,
\> {
  eventName: EventName;
  invocationId: string;
  correlationId: string;
  envelope: EventEnvelope\<TPayload, TMeta\>;
  source: EventSourceName;
  sourceType: EventSourceType;
  sourceContext: TSourceContext;
  log: DetectorLogger;
  metadata: Record\<string, unknown\>;
}

HandlerContext represents what a handler needs after detection.

export interface HandlerContext\<
  TPayload \= unknown,
  TMeta \= Record\<string, unknown\>,
\> {
  invocationId: string;
  correlationId: string;
  event: DetectedEvent\<TPayload, TMeta\>;
  envelope: EventEnvelope\<TPayload, TMeta\>;
  source: EventSourceName;
  sourceType: EventSourceType;
  log: HandlerLogger;
  metadata: Record\<string, unknown\>;
  signal?: AbortSignal;
}

The job() helper creates declarative job definitions. Jobs SHOULD be named explicitly or derive stable names from function names. Stable job names are important for observability, Flow Manifests, Compare Mode, retries, and operational debugging.

export function job\<
  TJobContext extends JobContext \= JobContext,
  TResult \= unknown,
\>(
  fn: JobFunction\<TJobContext, TResult\>,
  options?: JobOptions,
): JobDefinition\<TJobContext, TResult\>;

JobOptions describe execution behavior and metadata.

export interface JobOptions {
  name?: string;
  timeoutMs?: number;
  retries?: number;
  tags?: string\[\];
  metadata?: Record\<string, unknown\>;
  durable?: boolean | DurableJobOptions;
  continueOnFailure?: boolean;
}

run() is the core execution orchestrator. It executes job definitions for a detected event, builds JobContext, applies timeout and retry semantics, dispatches plugin lifecycle callbacks, collects results, and returns JobExecution records.

export async function run\<
  TPayload \= unknown,
  TMeta \= Record\<string, unknown\>,
\>(
  event: DetectedEvent\<TPayload, TMeta\>,
  jobs: JobDefinition\[\],
  options?: RunOptions,
): Promise\<JobExecution\[\]\>;

run() SHOULD support series and parallel execution modes. The default mode should be chosen to preserve current behavior during migration. Applications MAY opt into parallel execution when jobs are independent and safe to run concurrently.

export interface RunOptions {
  mode?: 'parallel' | 'series';
  continueOnFailure?: boolean;
  timeoutMs?: number;
  metadata?: Record\<string, unknown\>;
}

JobContext is passed into every job function. It contains runtime state, event data, envelope data, job metadata, logging, progress, checkpoints, and cancellation signals.

export interface JobContext\<
  TPayload \= unknown,
  TMeta \= Record\<string, unknown\>,
\> {
  invocationId: string;
  correlationId: string;
  event: DetectedEvent\<TPayload, TMeta\>;
  envelope: EventEnvelope\<TPayload, TMeta\>;
  job: {
    id: string;
    name: JobName;
    attempt: number;
    options: JobOptions;
    metadata: Record\<string, unknown\>;
  };
  log: JobLogger;
  progress(value: number, metadata?: Record\<string, unknown\>): Promise\<void\>;
  checkpoint(name: string, metadata?: Record\<string, unknown\>): Promise\<void\>;
  signal?: AbortSignal;
}

JobExecution records the result of running a job.

export interface JobExecution\<TResult \= unknown\> {
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
  metadata: Record\<string, unknown\>;
}

export type JobExecutionStatus \=
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'timed\_out'
  | 'cancelled';

These runtime types are the core interoperability surface between EventKit core, source adapters, plugins, observability, tests, and future architecture tooling.

# 10\. Handler and Job Execution

Handlers are responsible for orchestration, not low-level execution mechanics. A handler receives a DetectedEvent and HandlerContext, decides which jobs should run, and calls run() to execute them. The handler may contain simple branching logic, but significant business work should be delegated to jobs.

### Preferred handler style:

export const handler \= async (event, ctx) \=\> {
  return run(event, \[
    job(updateMoveTimeline),
    job(notifyDealer),
  \]);
};

Handlers MAY call run() more than once when orchestration requires separate phases. However, a handler SHOULD avoid becoming an implicit workflow engine. If a handler contains many conditional branches, it may indicate the need for clearer event boundaries, smaller jobs, or a Flow Manifest that documents the intended process.

Jobs should be focused units of work. A job may call external services, write to databases, publish notifications, update state, or perform other side effects. Because jobs are side-effecting, job implementations SHOULD be idempotent wherever practical. Retried jobs must not produce duplicate externally visible effects unless duplicates are safe or explicitly handled.

run() owns execution semantics. This includes constructing JobContext, emitting plugin callbacks, handling retries, applying timeouts, honoring AbortSignal cancellation, collecting outputs, serializing errors, and returning JobExecution records. Application handlers should not manually implement retry loops around jobs unless there is a highly specific reason.

When mode is series, jobs execute in the order provided. If continueOnFailure is false, a failed job SHOULD stop subsequent jobs. If continueOnFailure is true, subsequent jobs MAY continue and the final result should include both successful and failed JobExecution records.

When mode is parallel, jobs execute concurrently. The framework MUST still produce deterministic JobExecution records with stable job names, IDs, timings, status, and errors. Parallel execution should only be used when jobs do not depend on one another.

Timeouts may be defined at the job level or run() level. Job-level timeoutMs applies to a single job. Run-level timeoutMs applies to the entire group of jobs. The runtime SHOULD propagate cancellation through AbortSignal when timeouts occur.

Retries are owned semantically by EventKit core. Durability is owned by BatchJobs. This means core decides what retry behavior means, while BatchJobs persists retry state and schedules durable attempts.

# 11\. Plugin Architecture

Plugins are infrastructure extensions that observe and augment EventKit lifecycle events. Plugins MUST NOT be required for core detection and handling to work. A minimal EventKit runtime with no plugins should still normalize source payloads, evaluate detectors, create detected events, execute handlers, and run jobs.

Plugins are registered during EventKit initialization:

createEventKit({
  plugins: \[
    observability(),
    batchJobs(),
  \],
});

A plugin may implement any subset of lifecycle hooks. The runtime should call hooks in registration order unless a specific hook defines a different ordering rule. Plugin failures must be handled carefully. A plugin failure should be recorded and surfaced, but the framework should define which hooks are allowed to fail the invocation and which hooks are best-effort. Observability write failures, for example, should usually not prevent business execution unless the application explicitly configures strict behavior.

The plugin lifecycle surface includes:

export interface EventKitPlugin {
  onInvocationStart?(ctx: InvocationContext): Promise\<void\> | void;
  onInvocationEnd?(ctx: InvocationContext, result: InvocationResult): Promise\<void\> | void;
  onEventDetectionStart?(ctx: DetectorContext): Promise\<void\> | void;
  onEventDetectionEnd?(ctx: DetectorContext, result: DetectionResult): Promise\<void\> | void;
  onEventHandlerStart?(ctx: HandlerContext): Promise\<void\> | void;
  onEventHandlerEnd?(ctx: HandlerContext, result: HandlerResult): Promise\<void\> | void;
  onJobStart?(ctx: JobContext): Promise\<void\> | void;
  onJobProgress?(ctx: JobContext, progress: JobProgress): Promise\<void\> | void;
  onJobCheckpoint?(ctx: JobContext, checkpoint: JobCheckpoint): Promise\<void\> | void;
  onJobLog?(ctx: JobContext, entry: LogEntry): Promise\<void\> | void;
  onJobEnd?(ctx: JobContext, execution: JobExecution): Promise\<void\> | void;
  onError?(ctx: ErrorContext): Promise\<void\> | void;
  flush?(): Promise\<void\> | void;
  shutdown?(): Promise\<void\> | void;
}

Plugins MAY augment contexts by contributing metadata or extension fields. Context augmentation must be explicit and type-safe where possible. Plugins should not rely on mutation of arbitrary objects as their primary integration model because uncontrolled mutation makes the runtime harder to reason about.

Plugin authors SHOULD design hooks to be idempotent. Runtime retries, duplicate deliveries, and partial failures can cause hooks to be invoked more than once for logically similar work. Observability and durability plugins in particular must use stable IDs and upsert semantics where practical.

Plugins SHOULD avoid long blocking work inside hot lifecycle hooks. If a plugin needs to persist large payloads, send network requests, or perform expensive computation, it should batch, buffer, or defer that work where possible and flush at invocation end or shutdown.

# 12\. BatchJobs Plugin

BatchJobs is a durability plugin. It is not a source adapter and not the core execution engine. It integrates with EventKit's lifecycle to persist execution state, coordinate durable retries, manage delayed attempts, record retry history, and expose operational state.

The architectural split is:

\- EventKit Core owns execution semantics, retry semantics, timeout semantics, context construction, and lifecycle callbacks.
\- BatchJobs owns persisted execution state, retry scheduling, retry history, delayed retry metadata, lifecycle state transitions, and integration with existing batch job records.

This split allows the core runtime to remain generic. It also allows the system to support non-durable or in-memory execution in tests and local development while using BatchJobs for production durability.

BatchJobs may provide detector helpers for batch job row conventions, but those helpers must remain scoped to the plugin's domain. For example:

export const detector \= hasura.detector\<BatchJobRow\>((ctx) \=\> {
  const batchJobWasCreated \= batchJobs.detector.created(ctx);
  const isArV2Batch \= batchJobs.detector.triggerType(ctx, 'ar\_v2');

  return (
    batchJobWasCreated &&
    isArV2Batch
  );
});

These helpers operate on row-change contexts but do not own Hasura parsing and do not encode arbitrary HopDrive business logic. They are allowed because BatchJobs owns batch job record semantics.

### Durable job configuration should be explicit:

export const handler \= async (event, ctx) \=\> {
  return run(event, \[
    job(runARBatchV2, {
      durable: batchJobs.record(ctx.newRow),
      retries: 3,
      timeoutMs: 120000,
    }),
  \]);
};

BatchJobs should persist enough information to support debugging and recovery. At minimum this includes job execution ID, job name, event ID, invocation ID, correlation ID, attempt number, max attempts, status, created time, started time, completed time, failure details, retry schedule, durable payload reference, and metadata.

BatchJobs should integrate with Observability but should not depend on it. Durability and observability are related but distinct concerns. A durable job record records operational state. An observability record explains runtime behavior and trace context.

# 13\. Observability Plugin

The Observability plugin records runtime evidence. It should capture what EventKit did without changing what EventKit does. The plugin should be able to answer what happened for a specific invocation, event, job, correlation ID, tracking token, or flow.

Observability should record the Invocation \-\> Event \-\> Job hierarchy. This hierarchy mirrors the runtime and should remain the foundation of the data model.

Invocation records should include invocation ID, source adapter kind, source function, correlation ID, trace ID, tracking token, source payload reference, started timestamp, completed timestamp, failed timestamp, total duration, status, and source job ID when an invocation was triggered by a previous job.

Event records should include event execution ID, invocation ID, event name, detector module name, detected or skipped status, detection duration, handler status, handler duration, errors, flow ID hints, and expected node ID if known.

Job records should include job execution ID, event execution ID, invocation ID, job name, job function name, status, start time, completion time, failure time, duration, retry count, result summary, error details, logs, checkpoints, progress events, and expected node ID if known.

Observability should support runtime matching metadata for future Compare Mode:

{
  flowId?: string;
  expectedNodeId?: string;
  expectedEdgeId?: string;
  matchConfidence: 'exact' | 'inferred' | 'unmatched';
}

Runtime execution must not fail because no Flow Manifest exists. Observability should still capture observed runtime behavior. Compare Mode can classify unmatched execution later.

The Observability plugin SHOULD support payload redaction and payload references. Full raw payloads may contain sensitive data or large objects. The plugin should allow applications to configure what is stored directly, what is redacted, and what is stored by reference.

The plugin SHOULD provide a stable storage schema that supports the Console, CLI tools, tests, and AI context APIs. Runtime trace data should be queryable by invocation ID, correlation ID, event name, job name, status, flow ID, expected node ID, time range, and error classification.

# 14\. Expected Flow, Observed Flow, and Compare Mode

EventKit's long-term architecture tooling is based on three complementary views of system behavior: Expected Flow, Observed Flow, and Compare Mode.

Expected Flow is the design-time contract. It describes how a business process is intended to behave. It is authored primarily through Flow Manifests and enriched by generated metadata from code, Hasura metadata, event modules, job definitions, package imports, GraphQL operations, and source declarations.

Observed Flow is runtime evidence. It is captured by the Observability plugin as EventKit executes invocations, detects events, runs handlers, executes jobs, records logs, emits progress events, creates checkpoints, retries work, and fails or completes execution.

Compare Mode is the reconciliation layer. It overlays Observed Flow onto Expected Flow and classifies the differences. Compare Mode does not merely ask whether something succeeded or failed. It asks whether runtime behavior matched the declared business-process contract.

The core design principle is:

Expected Flow is the contract. Observed Flow is the evidence. Compare Mode is the truth-finding layer.

Compare Mode MUST NOT block production execution. Runtime execution should remain available even when no Flow Manifest exists, when a manifest is stale, or when runtime behavior diverges from expectation. Compare Mode is an observability, validation, debugging, and CI concern.

Compare Mode should classify differences precisely. Recommended classifications include:

\- expected\_missing: a required expected node did not execute.
\- optional\_not\_taken: an optional branch did not execute.
\- condition\_not\_met: a conditional branch did not execute for a known reason.
\- observed\_success: an expected node executed successfully.
\- observed\_failed: an expected node executed but failed.
\- unexpected\_observed: runtime behavior occurred that is not declared in the manifest.
\- retrying: a node is in retry state.
\- timed\_out: a node exceeded its timeout.
\- cancelled: a node was cancelled.
\- out\_of\_order: observed ordering violated expected edge ordering.
\- extra\_invocation\_chain: a job or side effect triggered another invocation not declared in the flow.

Compare Mode should produce a summary that is useful both to humans and machines:

Flow: mobile-service-dispatch
Expected nodes: 8
Observed matched: 6
Missing required: 1
Optional not taken: 1
Unexpected observed: 2
Failed: 1

This summary should link back to detailed records so an engineer can move from the flow-level diagnosis to invocation details, event records, job records, logs, source payloads, retry history, and code references.

Stable matching is the most important implementation challenge. The matcher should use the following priority order:

1\. Explicit expectedNodeId recorded at runtime.
2\. Explicit flowId plus event or job name.
3\. Event name exact match.
4\. Job name exact match.
5\. Source function plus lifecycle stage.
6\. Inferred match with warning.
7\. Unmatched observed node.

The matcher MUST preserve uncertainty. Inferred matches should carry matchConfidence \= inferred, and unmatched runtime behavior should remain visible rather than being silently discarded.

# 15\. Flow Manifests and Architecture Metadata

A Flow Manifest is a source-controlled declaration of a business process. It describes business intent, not implementation mechanics. Its purpose is to capture the expected shape, meaning, ownership, and operational interpretation of a workflow in a form that can be validated against code and compared against runtime behavior.

A Flow Manifest answers:

\- What business process is this?
\- What starts the flow?
\- Which business events may be detected?
\- Which jobs or side effects are expected?
\- Which branches are required, optional, conditional, or terminal?
\- What does successful completion mean?
\- Which owners, risks, and operational notes apply?
\- How should runtime observations be reconciled against expectation?

The manifest owns business meaning. Generated metadata owns structural facts.

A representative manifest:

id: mobile-service-dispatch
name: Mobile Service Dispatch
description: Dispatches a mobile service run and notifies the required parties.
owner: mobility
source:
  kind: hasura
  trigger: mobility\_runs.update
starts\_when:
  eventName: mobility.run.dispatch.requested
terminates\_when:
  \- mobility\_runs.status \= dispatched
  \- required notifications have completed or been skipped
nodes:
  \- id: event.run-dispatch-requested
    kind: event
    eventName: mobility.run.dispatch.requested
    required: true
  \- id: job.publish-event-log
    kind: job
    jobName: publishEventLog
    required: true
  \- id: job.notify-driver
    kind: job
    jobName: sendDriverPushNotification
    required: false
    condition: driver is assigned and push token exists
  \- id: job.send-customer-sms
    kind: job
    jobName: createCustomerSmsMessage
    required: false
    condition: customer phone number exists
edges:
  \- from: event.run-dispatch-requested
    to: job.publish-event-log
  \- from: event.run-dispatch-requested
    to: job.notify-driver
  \- from: event.run-dispatch-requested
    to: job.send-customer-sms

The manifest SHOULD include stable IDs, business names, descriptions, owners, required status, optional branches, conditions, terminal criteria, operational notes, runbook links, and related dashboards.

The manifest SHOULD NOT duplicate facts that can be generated from code. Generated metadata should identify event modules, detector exports, handler exports, job names, source adapter kind, Hasura trigger names, watched tables, source function paths, package imports, lifecycle event names, GraphQL operation names, generated TypeScript types, known runtime node kinds, and known source tables and operations.

The rule is:

The manifest describes meaning. The generator verifies structure.

Flow Manifest node kinds should include:

\- source
\- invocation
\- event
\- handler
\- job
\- sideEffect
\- terminal

Flow Manifest edges represent intended relationships between nodes. Edges may be required, optional, or conditional. Conditional edges SHOULD include human-readable explanations because code alone often cannot explain business intent.

### Recommended type shape:

export type FlowManifest \= {
  id: string;
  name: string;
  description?: string;
  owner?: string;
  source?: FlowSourceRef;
  nodes: FlowNode\[\];
  edges: FlowEdge\[\];
  metadata?: Record\<string, unknown\>;
};

export type FlowNode \= {
  id: string;
  kind: 'source' | 'invocation' | 'event' | 'handler' | 'job' | 'sideEffect' | 'terminal';
  eventName?: string;
  jobName?: string;
  sourceFunction?: string;
  required?: boolean;
  condition?: string;
  metadata?: Record\<string, unknown\>;
};

export type FlowEdge \= {
  from: string;
  to: string;
  required?: boolean;
  condition?: string;
};

Flow tooling SHOULD validate manifests in CI. Validation should include schema validation, duplicate ID detection, edge endpoint validation, node kind validation, terminal reachability, code reference validation, generated graph comparison, and optional strictness levels.

# 16\. EventKit Console

The EventKit Console should evolve from an observability viewer into an architecture explorer for business processes. It should allow engineers, operators, and AI agents to inspect intended behavior, observed runtime behavior, and differences between the two.

The Console MUST support Observed Mode. Observed Mode renders runtime invocation, event, handler, job, log, checkpoint, retry, and error data. This mode is useful even before Flow Manifests exist.

The Console SHOULD support Expected Mode. Expected Mode renders Flow Manifests and generated architecture metadata without requiring runtime data. This mode allows engineers to browse the intended architecture before or outside a production incident.

The Console SHOULD support Compare Mode. Compare Mode overlays Observed Flow onto Expected Flow and classifies mismatches. Compare Mode is the long-term operational diagnostic interface.

Console node types should include source, invocation, event, handler, job, side effect, terminal, unexpected observed, and external system. Node details should include expected definition, observed runtime record, matching reason, logs, errors, duration, related invocations, source payload excerpts, linked jobs, retry history, code links, owner metadata, and relevant tests.

Recommended node states include:

\- expected\_pending
\- observed\_success
\- observed\_failed
\- observed\_skipped
\- expected\_missing
\- unexpected\_observed
\- optional\_not\_taken
\- condition\_not\_met
\- retrying
\- timed\_out
\- cancelled

### Recommended visual semantics:

\- Green: expected and succeeded.
\- Red: expected and failed.
\- Gray: expected but not observed.
\- Blue: observed and matched.
\- Yellow: optional or conditionally skipped.
\- Purple: observed but not declared.
\- Dashed edge: conditional or optional path.
\- Solid edge: required path.

The Console should expose machine-readable APIs so AI agents can consume the same architecture and observability data as humans:

GET /flows/:flowId
GET /observations/:invocationId
GET /compare/:flowId/:invocationId

These APIs should return stable IDs, node metadata, edge metadata, runtime records, classifications, match confidence, related source references, and code references.

The Console should eventually answer:

\- What is this business process supposed to do?
\- What systems participate?
\- What events can fire?
\- What jobs can run?
\- What side effects can occur?
\- What happened for this specific transaction?
\- What differed from expectation?
\- Which code owns this behavior?
\- Which tests cover this path?
\- Which flow manifests are stale?
\- Which runtime paths are undocumented?

# 17\. Package Structure and Public API

EventKit should be published as a single package:

@hopdrive/eventkit

Optional capabilities should be exposed through subpath exports rather than separate packages. This keeps the HopDrive package scope clean and avoids the operational burden of versioning many small internal packages.

### Recommended import patterns:

import { createEventKit, job, run } from '@hopdrive/eventkit';
import { hasura } from '@hopdrive/eventkit/sources/hasura';
import { webhook } from '@hopdrive/eventkit/sources/webhook';
import { cron } from '@hopdrive/eventkit/sources/cron';
import { batchJobs } from '@hopdrive/eventkit/plugins/batchjobs';
import { observability } from '@hopdrive/eventkit/plugins/observability';

The package should be internally modular even though it is published as one package. Internal structure may include:

@hopdrive/eventkit
  /core
  /runtime
  /registry
  /sources/hasura
  /sources/webhook
  /sources/cron
  /sources/application
  /sources/queue
  /plugins/batchjobs
  /plugins/observability
  /console
  /flow
  /testing

Public exports should be intentionally narrow. The package should expose stable runtime types, source adapter types, plugin types, flow manifest types, test helpers, and registration functions. Internal scheduler implementation, lifecycle dispatch internals, retry internals, storage adapters, and graph generation internals should remain private unless intentionally promoted to public API.

The public API MUST distinguish between stable extension contracts and implementation details. SourceAdapter, EventModule, EventKitPlugin, EventEnvelope, DetectorContext, DetectedEvent, HandlerContext, JobContext, JobExecution, FlowManifest, createEventKit(), job(), and run() are extension contracts. Internal runtime helper functions are not.

The package should use semantic versioning. Breaking changes to public contracts require a major version. Internal implementation changes may ship in minor or patch releases if public behavior remains compatible.

# 18\. Configuration and Registration

EventKit initialization should be explicit and deterministic. Applications register sources, plugins, and event modules at startup.

Example:

createEventKit({
  sources: \[
    hasura(),
    webhook(),
    cron(),
  \],
  plugins: \[
    observability(),
    batchJobs(),
  \],
  events: \[
    movePickupStarted,
    moveDeliveryArrived,
    acertusOrderCreated,
  \],
});

Explicit registration is required because it works reliably in serverless packaging contexts. Automatic filesystem discovery is deferred. If build-time discovery is introduced later, it should generate explicit registration artifacts rather than relying on runtime dynamic imports.

The runtime SHOULD validate registration at startup. Validation should detect duplicate event names, missing detectors, missing handlers, invalid source adapter names, duplicate plugin IDs, unsupported source types, and incompatible plugin configuration.

Event module registration should be type-safe. An EventModule should include name, detector, handler, and optional metadata. Metadata may include description, tags, flow hints, owner, deprecated status, and related documentation.

Source registration should identify source name and source type. Source names should be stable because observability, Flow Manifests, and metrics may reference them.

Plugin registration should identify plugin name, version, capabilities, and lifecycle hooks. Plugin configuration should be validated before the first invocation is processed.

# 19\. Migration Strategy

Migration from Hasura Event Detector to EventKit should be incremental. The goal is to preserve working behavior while gradually moving the architecture to the new runtime.

### Recommended phases:

1\. Introduce @hopdrive/eventkit alongside the existing package.
2\. Implement the compatibility facade for @hopdrive/hasura-event-detector.
3\. Port shared runtime primitives such as job(), run(), logging, error serialization, and lifecycle types.
4\. Implement the Hasura source adapter.
5\. Migrate event modules one at a time.
6\. Enable Observability plugin capture for migrated events.
7\. Enable BatchJobs durability for migrated jobs.
8\. Add Flow Manifests for one high-value workflow.
9\. Validate generated architecture metadata in CI.
10\. Expand migration to remaining event modules.

The compatibility facade should allow existing consumers to continue importing from @hopdrive/hasura-event-detector while delegating internally to EventKit where possible. Deprecation timing is intentionally deferred until the migration is substantially complete.

Migration should preserve detector readability. Migration should not force application teams to rewrite business helpers unless those helpers are currently embedded in framework code. HopDrive-specific helpers should move to application/domain packages rather than EventKit packages.

Example import migration:

Before:

import { hasuraEvent } from '@hopdrive/hasura-event-detector';

After:

import { hasura } from '@hopdrive/eventkit/sources/hasura';

Before:

export const detector \= hasuraEvent\<MoveRow\>((ctx) \=\> { ... });

After:

export const detector \= hasura.detector\<MoveRow\>((ctx) \=\> { ... });

A migrated event module should preserve the event name, detector semantics, handler behavior, job names, retry behavior, and observability identifiers unless a deliberate breaking change is made.

# 20\. Testing Strategy

Testing must validate EventKit at multiple layers. No single test category is sufficient.

Detector unit tests should verify detector predicates in isolation. They should provide source-specific detector contexts and assert true or false outcomes for meaningful business cases. For Hasura, tests should cover insert/update/delete operations, changed and unchanged columns, missing oldRow/newRow, manual invocations, and invalid payloads.

Handler tests should verify orchestration. They should assert that handlers call run() with the expected job definitions under specific contexts. Handler tests should not need to execute the actual jobs unless explicitly testing an integration path.

Job tests should verify business side effects. Jobs should be tested as ordinary functions receiving JobContext. Tests should cover idempotency, retry safety, expected outputs, external service errors, timeout behavior, and cancellation when practical.

Plugin tests should verify lifecycle behavior. A plugin test should simulate invocation, detection, handler, job, progress, checkpoint, error, flush, and shutdown callbacks. Plugins should be tested for idempotency and failure handling.

Source adapter tests should verify normalization. They should provide raw source payloads and assert the produced EventEnvelope and source-specific detector context. Hasura adapter tests should include representative Hasura trigger payloads. Webhook tests should include headers, methods, vendor event types, and signature verification metadata. Cron tests should include schedule names and scheduled timestamps.

Runtime integration tests should execute complete flows through createEventKit(), source adapter normalization, detector evaluation, handler execution, run(), plugin callbacks, and result collection.

Flow tests should validate Flow Manifests, generated metadata, graph generation, expected node identity, observed matching, and Compare Mode classifications.

Golden trace tests should capture known invocation/event/job traces and compare future runtime output against expected snapshots. These tests are especially useful for preventing observability regressions.

# 21\. CI Validation

CI should continuously validate that implementation, architecture metadata, and Flow Manifests remain aligned.

Recommended CI checks:

\- TypeScript compile.
\- Lint.
\- Unit tests.
\- Integration tests.
\- Runtime API compatibility tests.
\- Flow Manifest schema validation.
\- Flow Manifest code reference validation.
\- Generated graph validation.
\- Architecture artifact drift detection.
\- Package boundary enforcement.
\- Dependency graph checks.

Flow validation should support strictness levels:

warn: report drift but do not fail.
strict: fail on missing references, invalid manifests, or stale generated graphs.
release: fail on any required flow inconsistency.

Recommended defaults:

\- local development: warn
\- pull request: strict
\- release branch: release

Generated architecture artifacts may include:

architecture/generated/flows.json
architecture/generated/flows.mmd
architecture/generated/flows.reactflow.json
architecture/generated/package-graph.json
architecture/generated/event-graph.json
architecture/generated/data-graph.json

CI should fail if generated artifacts differ from committed artifacts in strict or release mode. This makes architecture drift visible in code review.

CI should require flow validation when changes touch events, jobs, functions, Hasura metadata, packages/eventkit, observability, or architecture/flows.

# 22\. Architecture Decision Records

Architecture Decision Records should preserve not only the final decision but also the context, alternatives, tradeoffs, and consequences.

## ADR-001: EventKit is source-agnostic.

Decision: EventKit models business events independently of source transport.
Rationale: The existing Hasura Event Detector is useful, but its capabilities should apply to webhooks, cron events, application events, queues, and future sources.
Consequence: Hasura becomes a source adapter rather than the framework identity.

## ADR-002: Hasura is a source adapter.

Decision: Hasura-specific behavior belongs in @hopdrive/eventkit/sources/hasura.
Rationale: Hasura owns database event semantics such as operation, table, old row, new row, and changed columns. It must not own HopDrive business rules.
Consequence: Hasura helpers remain available without coupling EventKit core to Hasura.

## ADR-003: Event modules remain the primary authoring experience.

Decision: Business events are authored as event modules exporting detector and handler.
Rationale: The current authoring experience is one of the strongest existing architectural features.
Consequence: Event module readability remains a top-level design constraint.

## ADR-004: One detector per event module.

Decision: Each event module exports exactly one detector.
Rationale: This preserves simplicity, readability, tooling, and deterministic event identity.
Consequence: Multi-source detection for the same business semantic is deferred.

## ADR-005: Explicit module registration.

Decision: Event modules are registered explicitly during initialization.
Rationale: Runtime auto-discovery is brittle in Netlify and serverless packaging contexts.
Consequence: Applications must maintain registration lists or generated registration files.

## ADR-006: EventEnvelope and DetectedEvent are separate.

Decision: EventEnvelope represents inbound payload. DetectedEvent represents matched business event.
Rationale: This models the pipeline clearly and prevents transport concerns from polluting business-event records.
Consequence: Observability can separately track what came in and what was detected.

## ADR-007: DetectedEvent does not carry DetectorContext.

Decision: DetectorContext is detection-only and discarded after detection.
Rationale: Handlers should not rely on detector-only helpers like columnChanged().
Consequence: Handlers use HandlerContext, envelope payload, or source-specific handler extensions.

## ADR-008: Core owns retry semantics; BatchJobs owns durability.

Decision: Core defines retry meaning and lifecycle. BatchJobs persists retry state and schedules durable attempts.
Rationale: This allows core to remain generic while BatchJobs provides production durability.
Consequence: In-memory execution and durable execution share the same semantic model.

## ADR-009: EventKit is one package with subpath exports.

Decision: Publish @hopdrive/eventkit as one package.
Rationale: Avoid cluttering the HopDrive package scope with many small packages.
Consequence: Optional capabilities are exposed through subpath exports.

## ADR-010: Expected Flow and Observed Flow remain separate.

Decision: Expected Flow is design-time contract. Observed Flow is runtime evidence.
Rationale: Documentation can be stale and runtime can be surprising. Both are valuable.
Consequence: Compare Mode reconciles both without replacing either.
.
