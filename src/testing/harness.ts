// =============================================================================
// eventkit/testing — recording harness, doubles, assertions (ADR-036)
// =============================================================================
// The consumer-facing test surface. Everything here drives the REAL runtime and
// reads what actually happened — never a mock of it (the legacy failure mode was
// mocks of run()/job() that drifted from reality). See testing-strategy.md §2 and
// the four-layer consumer pyramid in docs/guide.html.
import {
  asEventName,
  asInvocationId,
  type DetectorContext,
  type EventKit,
  type EventKitPlugin,
  type EventModule,
  type HandlerLogger,
  type InvocationResult,
  type JobExecution,
  type KitDescription,
  type LogEntry,
  type RequestContext,
  type ResolvedOutcome,
} from '../core/index.js';
import type { BatchJobStore, BatchJobUpdate, DelayedBatchJobSpec } from '../plugins/batch/index.js';
import { observability } from '../plugins/observability/index.js';
import type { InvocationRecord, EventRecord, JobRecord, ObservabilityBatch } from '../plugins/observability/index.js';
import { toFlowGraph, flowNodeId } from '../flow/index.js';
import { recordingPlugin } from './instruments.js';
import { hasuraManualEdit, isWebhookRequest } from './builders.js';

// ── testInvocation ───────────────────────────────────────────────────────────

/** The assertable result of running a real invocation through `testInvocation`. */
export interface TestInvocationResult {
  /** The raw `handle()` result. */
  result: InvocationResult;
  ok: boolean;
  /** Names of the events whose detector fired. */
  firedEvents: string[];
  /** Every job execution across all fired events, flattened. */
  jobs: JobExecution[];
  /** A single job execution by name (first match), or undefined. */
  job(name: string): JobExecution | undefined;
  /** The response a `resolve`/`respond` produced (output or error), if any. */
  resolved: ResolvedOutcome | undefined;
  /** Every framework + job log entry captured via onLog/onJobLog, in order. */
  logs: LogEntry[];
  /** The lifecycle hook sequence (names, in order). */
  sequence: string[];
  /** The observability records the kit emitted (schema contract). */
  records: { invocations: InvocationRecord[]; events: EventRecord[]; jobs: JobRecord[] };
  /** Every `onError` payload the runtime routed. */
  errors: unknown[];
}

/**
 * Run a real invocation and return an assertable snapshot of everything that happened:
 * which detectors fired, each job's execution, the response, logs, hook sequence, and the
 * observability records. Pass a raw payload (or a `webhookRequest(...)` / builder result);
 * an optional `request` overrides/augments the RequestContext.
 *
 * NOTE: attaches its own recorder + in-memory observability sink, so pass a FRESHLY-built
 * kit (one that has not yet been resolved by a prior `handle()`/`validate()`).
 */
export async function testInvocation(kit: EventKit, input: unknown, request?: RequestContext): Promise<TestInvocationResult> {
  const rec = recordingPlugin('test-invocation-recorder');
  const memBatches: ObservabilityBatch[] = [];
  kit.use(rec.plugin);
  kit.use(observability, { sink: (batch: ObservabilityBatch) => void memBatches.push(batch) });

  let payload: unknown = input;
  let req: RequestContext | undefined = request;
  if (isWebhookRequest(input)) {
    payload = input.body;
    req = { ...(input.request as RequestContext), ...(request ?? {}) };
  }

  const result = await kit.handle(payload, req);

  const logs: LogEntry[] = [];
  for (const c of rec.calls) {
    if (c.hook === 'onLog') logs.push(c.args[0] as LogEntry);
    else if (c.hook === 'onJobLog') logs.push(c.args[1] as LogEntry);
  }
  const jobs = result.events.flatMap((e) => e.jobs);
  return {
    result,
    ok: result.ok,
    firedEvents: result.events.filter((e) => e.detected).map((e) => e.name),
    jobs,
    job: (name) => jobs.find((j) => j.jobName === name),
    resolved: result.resolved,
    logs,
    sequence: rec.sequence(),
    records: {
      invocations: memBatches.flatMap((b) => (b.invocation ? [b.invocation] : [])),
      events: memBatches.flatMap((b) => b.events),
      jobs: memBatches.flatMap((b) => b.jobs),
    },
    errors: rec.errors,
  };
}

// ── detectorContract ─────────────────────────────────────────────────────────

/** Payloads a module's detector MUST fire on, and payloads it MUST suppress. */
export interface DetectorContractCases {
  fires: unknown[];
  suppresses: unknown[];
}

export interface DetectorContractReport {
  ok: boolean;
  ran: number;
  failures: Array<{ kind: 'fires' | 'suppresses'; index: number; expected: boolean; actual: boolean }>;
}

/** Minimal detector-context build (mirrors buildDetectorContextFor, inlined to stay acyclic). */
function detectorCtx(source: EventKitPlugin, raw: unknown, eventName: string): DetectorContext {
  if (!source.normalize) throw new Error(`Source '${source.name}' does not implement normalize().`);
  const envelope = source.normalize(raw, {});
  const base: DetectorContext = {
    eventName: asEventName(eventName),
    invocationId: asInvocationId('contract-test'),
    correlationId: envelope.correlationId,
    envelope,
    source: envelope.source,
    sourceType: envelope.sourceType,
    log: { debug() {} },
    metadata: {},
    provided: {},
  };
  return (source.buildDetectorContext ? source.buildDetectorContext(envelope, base) : base) as DetectorContext;
}

const isHasuraEventSource = (source: EventKitPlugin): boolean =>
  (source as { sourceType?: string }).sourceType === 'database' || /hasura-event/.test(source.name);

/**
 * Run a detector against a table of payloads it MUST fire on and payloads it MUST suppress,
 * exercised through the source's real `normalize` + detector context. For a `hasuraEvent`
 * module, a MANUAL-operation payload is AUTO-APPENDED to `suppresses` — mechanizing the D17
 * console-edit silent-regression guard into every consumer repo by default.
 *
 * Throws with a readable report if any case fails; returns the report on success.
 */
export async function detectorContract(
  source: EventKitPlugin,
  module: EventModule,
  cases: DetectorContractCases,
): Promise<DetectorContractReport> {
  const suppresses = [...cases.suppresses];
  if (isHasuraEventSource(source)) suppresses.push(hasuraManualEdit('_contract.manual_check', {}, {}));

  const failures: DetectorContractReport['failures'] = [];
  let ran = 0;

  const check = async (payloads: unknown[], expected: boolean, kind: 'fires' | 'suppresses') => {
    for (let i = 0; i < payloads.length; i++) {
      ran++;
      const ctx = detectorCtx(source, payloads[i], String(module.name));
      const actual = (await module.detector(ctx)) === true;
      if (actual !== expected) failures.push({ kind, index: i, expected, actual });
    }
  };

  await check(cases.fires, true, 'fires');
  await check(suppresses, false, 'suppresses');

  const report: DetectorContractReport = { ok: failures.length === 0, ran, failures };
  if (!report.ok) {
    const lines = failures.map(
      (f) => `  ✗ ${kindLabel(f.kind)}[${f.index}] expected detector=${f.expected} but got ${f.actual}`,
    );
    throw new Error(`detectorContract('${String(module.name)}'): ${failures.length} case(s) failed:\n${lines.join('\n')}`);
  }
  return report;
}

const kindLabel = (kind: 'fires' | 'suppresses'): string => (kind === 'fires' ? 'fires' : 'suppresses');

// ── Memory doubles ─────────────────────────────────────────────────────────

/** An in-memory `BatchJobStore` that records every `update()` / `enqueueDelayed()` call. */
export interface MemoryBatchStore extends BatchJobStore {
  /** Every `update(id, fields)` call, in order. */
  updates: Array<{ id: string | number; fields: BatchJobUpdate }>;
  /** Every `enqueueDelayed(spec)` call, in order. */
  delayed: DelayedBatchJobSpec[];
  reset(): void;
}

export function memoryBatchStore(): MemoryBatchStore {
  const updates: Array<{ id: string | number; fields: BatchJobUpdate }> = [];
  const delayed: DelayedBatchJobSpec[] = [];
  return {
    update(id, fields) {
      updates.push({ id, fields });
    },
    enqueueDelayed(spec) {
      delayed.push(spec);
    },
    updates,
    delayed,
    reset() {
      updates.length = 0;
      delayed.length = 0;
    },
  };
}

/** A `HandlerLogger` that captures every entry, so a test can assert what a job/handler logged. */
export interface CapturedLogEntry {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
  error?: unknown;
}

export interface CapturedLogger extends HandlerLogger {
  entries: CapturedLogEntry[];
  reset(): void;
}

export function capturedLogger(): CapturedLogger {
  const entries: CapturedLogEntry[] = [];
  const push = (level: CapturedLogEntry['level'], message: string, data?: Record<string, unknown>, error?: unknown) => {
    const e: CapturedLogEntry = { level, message };
    if (data !== undefined) e.data = data;
    if (error !== undefined) e.error = error;
    entries.push(e);
  };
  return {
    debug: (m, d) => push('debug', m, d),
    info: (m, d) => push('info', m, d),
    warn: (m, d) => push('warn', m, d),
    error: (m, err, d) => push('error', m, d, err),
    entries,
    reset: () => {
      entries.length = 0;
    },
  };
}

// ── simulateChain ─────────────────────────────────────────────────────────

export interface SimulateChainResult {
  /** The parent (first) invocation. */
  parent: TestInvocationResult;
  /** The child (second) invocation, built from the parent's link. */
  child: TestInvocationResult;
  /** The parent invocation's correlation id (the chain root). */
  parentCorrelationId: string;
  /** The child invocation's correlation id. */
  childCorrelationId: string;
  /** True iff the child rejoined the parent's correlation chain (continuity held). */
  continuous: boolean;
}

/**
 * Prove correlation continuity across a two-hop chain (ADR-028). Runs a parent invocation,
 * then builds the second payload from the parent's `{ correlationId, jobId }` via `second`
 * — model Mechanism A (echoWebhook: the vendor echoes the token back in the body) or
 * Mechanism B (lookupWebhook: the token is recovered from a stored correlation) by how the
 * `second` builder embeds the link. Returns both invocations and whether the child rejoined
 * the chain. A `second` that ignores the link models the miss → clean-root case (continuity
 * false). Pass fresh kits (each invocation attaches its own recorder).
 */
export async function simulateChain(
  parentKit: EventKit,
  parentInput: unknown,
  childKit: EventKit,
  second: (link: { correlationId: string; jobId: string }) => unknown,
): Promise<SimulateChainResult> {
  const parent = await testInvocation(parentKit, parentInput);
  const parentCorrelationId = parent.records.invocations[0]?.correlation_id ?? '';
  const parentJobId = parent.records.jobs[0]?.id ?? parent.jobs[0]?.id ?? '';

  const child = await testInvocation(childKit, second({ correlationId: parentCorrelationId, jobId: parentJobId }));
  const childCorrelationId = child.records.invocations[0]?.correlation_id ?? '';

  return {
    parent,
    child,
    parentCorrelationId,
    childCorrelationId,
    continuous: !!parentCorrelationId && childCorrelationId === parentCorrelationId,
  };
}

// ── proto-Compare: observed ⊆ expected flow ──────────────────────────────────

export interface ObservedFlowComparison {
  ok: boolean;
  /** The flow node ids the invocation actually produced. */
  observed: string[];
  /** Observed node ids that are NOT in the kit's expected flow graph. */
  unexpected: string[];
}

/** The flow node ids an invocation produced (fired events + their jobs), via the shared builders. */
export function observedFlowNodes(result: TestInvocationResult): string[] {
  const ids = new Set<string>();
  for (const ev of result.result.events) {
    if (!ev.detected) continue;
    ids.add(flowNodeId.event(ev.name));
    for (const j of ev.jobs) ids.add(flowNodeId.job(ev.name, j.jobName));
  }
  return [...ids];
}

/**
 * Proto-Compare (ADR-037): assert the observed runtime record set is a SUBSET of the kit's
 * EXPECTED flow graph, using the shared node-id builders — so an invocation can only fire
 * events/jobs the declared flow already knows about. Validates the Compare-Mode matcher
 * hypothesis (D9) on one real flow, months before the Console. Throws on any unexpected node.
 */
export function assertObservedWithinFlow(kit: EventKit, result: TestInvocationResult): ObservedFlowComparison {
  const expected = new Set(toFlowGraph(kit).nodes.map((n) => n.id));
  const observed = observedFlowNodes(result);
  const unexpected = observed.filter((id) => !expected.has(id));
  if (unexpected.length) {
    throw new Error(
      `assertObservedWithinFlow: observed nodes absent from the expected flow graph:\n${unexpected.map((u) => `  - ${u}`).join('\n')}`,
    );
  }
  return { ok: true, observed, unexpected };
}

// ── expectFlow ─────────────────────────────────────────────────────────────

/** Fluent assertions over one event in a kit's declared flow (`kit.describe()`). */
export interface FlowEventAssertion {
  /** Assert the event exists in the kit. */
  exists(): FlowEventAssertion;
  /** Assert the event declares EXACTLY these job names (order-independent). */
  hasJobs(...names: string[]): FlowEventAssertion;
  /** Assert the event declares a job with this name. */
  hasJob(name: string): FlowEventAssertion;
  /** Assert the event's response kind ('none' | 'resolve' | 'respond'). */
  respondsWith(kind: 'none' | 'resolve' | 'respond'): FlowEventAssertion;
  /** The declared job names for this event. */
  jobNames(): string[];
}

export interface FlowAssertion {
  /** Assertions scoped to one event by name. */
  event(name: string): FlowEventAssertion;
  /** Assert the kit declares EXACTLY these event names (order-independent). */
  hasEvents(...names: string[]): FlowAssertion;
  /** All declared event names. */
  eventNames(): string[];
  /** The underlying description. */
  description: KitDescription;
}

/**
 * Assert a kit's declared flow — its events and their static job sets — read from
 * `kit.describe()` (no invocation runs). Complements a `toFlowYaml(kit)` snapshot: the
 * snapshot catches ANY change, `expectFlow` pins the specific structure you care about.
 */
export function expectFlow(kit: EventKit): FlowAssertion {
  const description = kit.describe();
  const eventNames = () => description.events.map((e) => e.name);

  const flow: FlowAssertion = {
    description,
    eventNames,
    hasEvents(...names) {
      const actual = eventNames().slice().sort();
      const expected = names.slice().sort();
      if (actual.length !== expected.length || actual.some((n, i) => n !== expected[i])) {
        throw new Error(`expectFlow: events mismatch.\n  expected: ${expected.join(', ')}\n  actual:   ${actual.join(', ')}`);
      }
      return flow;
    },
    event(name) {
      const ev = description.events.find((e) => e.name === name);
      const jobNames = () => (ev ? ev.jobs.map((j) => j.name) : []);
      const assertion: FlowEventAssertion = {
        jobNames,
        exists() {
          if (!ev) throw new Error(`expectFlow.event('${name}'): no such event. Have: ${eventNames().join(', ') || '(none)'}`);
          return assertion;
        },
        hasJob(job) {
          assertion.exists();
          if (!jobNames().includes(job)) {
            throw new Error(`expectFlow.event('${name}').hasJob('${job}'): not found. Jobs: ${jobNames().join(', ') || '(none)'}`);
          }
          return assertion;
        },
        hasJobs(...names) {
          assertion.exists();
          const actual = jobNames().slice().sort();
          const expected = names.slice().sort();
          if (actual.length !== expected.length || actual.some((n, i) => n !== expected[i])) {
            throw new Error(`expectFlow.event('${name}').hasJobs: mismatch.\n  expected: ${expected.join(', ')}\n  actual:   ${actual.join(', ')}`);
          }
          return assertion;
        },
        respondsWith(kind) {
          assertion.exists();
          if (ev!.response !== kind) {
            throw new Error(`expectFlow.event('${name}').respondsWith('${kind}'): actual response is '${ev!.response}'.`);
          }
          return assertion;
        },
      };
      return assertion;
    },
  };
  return flow;
}
