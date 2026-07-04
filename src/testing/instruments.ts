// =============================================================================
// eventkit/testing — recording instruments (ADR-036)
// =============================================================================
// Capture what actually happened in a REAL invocation, so tests assert against the
// runtime, not a mock of it. `recordingPlugin` observes every notification hook;
// `memorySink` captures the exact observability records. Both are the substrate the
// higher-level harness (`testInvocation`) composes.
import type { EventKitPlugin } from '../core/index.js';
import type { ObservabilityBatch, InvocationRecord, EventRecord, JobRecord } from '../plugins/observability/index.js';

/**
 * A recording plugin. Register it with `kit.use(rec.plugin)`; after `handle()`,
 * read the ordered hook-call log. Records every notification (`on*`) hook — never
 * transforms — so it observes without changing behavior.
 */
export interface RecordingPlugin {
  plugin: EventKitPlugin;
  /** Every notification hook fired, in order, with its raw args. */
  calls: Array<{ hook: string; args: readonly unknown[] }>;
  /** Just the hook names, in order — the lifecycle sequence to snapshot. */
  sequence(): string[];
  /** Every `onError` payload (the `ErrorContext`s the runtime routed here). */
  errors: unknown[];
  /** How many times `onFlush` ran (must be ≥1 for every invocation, incl. throws). */
  flushCount(): number;
  /** Clear the log for reuse across invocations. */
  reset(): void;
}

const NOTIFICATION_HOOKS = [
  'onInit', 'onInvocationStart', 'onInvocationEnd',
  'onEventDetectionStart', 'onEventDetectionEnd',
  'onEventHandlerStart', 'onEventHandlerEnd',
  'onJobStart', 'onJobProgress', 'onJobCheckpoint', 'onJobLog', 'onJobEnd',
  'onLog', 'onError', 'onBeforeNormalize', 'onAfterNormalize',
  'onFlush', 'onShutdown',
] as const;

export function recordingPlugin(name = 'recorder'): RecordingPlugin {
  const calls: Array<{ hook: string; args: readonly unknown[] }> = [];
  const errors: unknown[] = [];
  const plugin: Record<string, unknown> = { name };
  for (const hook of NOTIFICATION_HOOKS) {
    plugin[hook] = (...args: unknown[]) => {
      calls.push({ hook, args });
      if (hook === 'onError') errors.push(args[0]);
    };
  }
  return {
    plugin: plugin as unknown as EventKitPlugin,
    calls,
    errors,
    sequence: () => calls.map((c) => c.hook),
    flushCount: () => calls.filter((c) => c.hook === 'onFlush').length,
    reset: () => {
      calls.length = 0;
      errors.length = 0;
    },
  };
}

/**
 * An in-memory observability sink. Register it with
 * `kit.use(observability, { sink: mem })` — `mem` is callable — then read the
 * captured records. Lets a test assert the exact observability rows (the schema
 * contract with Grafana/Console) with no database.
 */
export interface MemorySink {
  (batch: ObservabilityBatch): void;
  /** Every flushed batch, in order. */
  batches: ObservabilityBatch[];
  /** All invocation records across every batch. */
  invocations(): InvocationRecord[];
  /** All event records across every batch. */
  events(): EventRecord[];
  /** All job records across every batch. */
  jobs(): JobRecord[];
  reset(): void;
}

export function memorySink(): MemorySink {
  const batches: ObservabilityBatch[] = [];
  const sink = ((batch: ObservabilityBatch) => {
    batches.push(batch);
  }) as MemorySink;
  sink.batches = batches;
  sink.invocations = () => batches.flatMap((b) => (b.invocation ? [b.invocation] : []));
  sink.events = () => batches.flatMap((b) => b.events);
  sink.jobs = () => batches.flatMap((b) => b.jobs);
  sink.reset = () => {
    batches.length = 0;
  };
  return sink;
}
