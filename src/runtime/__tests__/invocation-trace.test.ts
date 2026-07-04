// =============================================================================
// Lifecycle-ordering + golden-trace (testing-strategy.md §1 P0-B / P0-C)
// =============================================================================
// Two things nothing else pins:
//   B. the plugin hook-call SEQUENCE for one rich invocation (§11 order contract)
//   C. the exact observability RECORDS a scripted invocation produces — the schema
//      contract with Grafana and the Console. Volatile fields (ids, timestamps,
//      durations) are normalized so the snapshot is stable; the semantic fields
//      (statuses, counts, correlation + source_job_id linkage, logs) are asserted
//      explicitly on top.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { createEventKit, defineEvent, job } from '../../index.js';
import { observability } from '../../plugins/observability/index.js';
import { fakeSource, memorySink, recordingPlugin } from '../../testing/index.js';

/** One rich invocation: two jobs (a winner + a failer) under a single detected event. */
function richModule() {
  return defineEvent({
    name: 'test.rich',
    detector: () => true,
    jobs: [
      job((ctx) => { ctx.log.info('winner ran'); return { ok: true }; }, { name: 'winner' }),
      job(() => { throw new Error('kaboom'); }, { name: 'failer' }),
    ],
  });
}

/** Replace non-deterministic fields with stable tokens so the record shape can be snapshotted. */
const VOLATILE = new Set([
  'id', 'invocation_id', 'event_execution_id', 'correlation_id', 'invocationId', 'correlationId',
  'created_at', 'updated_at', 'source_event_time',
  'duration_ms', 'total_duration_ms', 'detection_duration_ms', 'handler_duration_ms', 'durationMs',
  'error_stack',
]);
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = VOLATILE.has(k) ? (v === undefined ? undefined : `<${k}>`) : normalize(v);
    }
    return out;
  }
  return value;
}

describe('lifecycle ordering (§11 hook sequence)', () => {
  it('runs hooks in the documented order for a detect → handle → 2-job invocation', async () => {
    const recorder = recordingPlugin();
    const kit = createEventKit(fakeSource()).use(recorder.plugin).registerEvents([richModule()]);
    await kit.handle({ hi: 1 });

    const seq = recorder.sequence();
    // The spine is fixed regardless of the (parallel) per-job interleaving.
    expect(seq[0]).toBe('onInit');
    expect(seq).toContain('onInvocationStart');
    expect(seq.indexOf('onEventDetectionStart')).toBeLessThan(seq.indexOf('onEventDetectionEnd'));
    expect(seq.indexOf('onEventDetectionEnd')).toBeLessThan(seq.indexOf('onEventHandlerStart'));
    expect(seq.indexOf('onEventHandlerStart')).toBeLessThan(seq.indexOf('onJobStart'));
    // onInvocationEnd is the penultimate step; onFlush is last, and each runs exactly once.
    expect(seq.filter((h) => h === 'onInvocationEnd')).toHaveLength(1);
    expect(seq.filter((h) => h === 'onFlush')).toHaveLength(1);
    expect(seq.indexOf('onInvocationEnd')).toBeLessThan(seq.indexOf('onFlush'));
    expect(seq[seq.length - 1]).toBe('onFlush');

    // Full sequence snapshot — a reorder that changes observability attribution fails here.
    expect(seq).toMatchSnapshot();
  });
});

describe('golden-trace observability records (schema contract)', () => {
  it('emits invocation/event/job records with the expected shape and semantics', async () => {
    const mem = memorySink();
    const kit = createEventKit(fakeSource({ correlationId: 'corr-1' }))
      .use(observability, { sink: mem })
      .registerEvents([richModule()]);

    const result = await kit.handle({ hi: 1 });

    // Records buffer per invocation and may be re-flushed idempotently (eager persist at
    // job start). Dedupe by id, taking the LAST occurrence (final status), so the golden
    // shape is asserted on the settled records regardless of how many times they re-flush.
    const lastById = <T extends { id: string }>(rows: T[]): T[] => [...new Map(rows.map(r => [r.id, r])).values()];
    const invocations = lastById(mem.invocations());
    expect(invocations).toHaveLength(1); // exactly one distinct invocation
    const inv = invocations[0];
    const events = lastById(mem.events());
    const jobs = lastById(mem.jobs());

    // Invocation record: counts reflect one detected event, two jobs, one failure.
    expect(inv.events_detected_count).toBe(1);
    expect(inv.total_jobs_run).toBe(2);
    expect(inv.total_jobs_succeeded).toBe(1);
    expect(inv.total_jobs_failed).toBe(1);
    expect(inv.source_system).toBe('fake');
    expect(inv.correlation_id).toBe('corr-1');

    // Event record links to the invocation + correlation and reports its job tallies.
    expect(events).toHaveLength(1);
    expect(events[0].event_name).toBe('test.rich');
    expect(events[0].detected).toBe(true);
    expect(events[0].correlation_id).toBe('corr-1');
    expect(events[0].jobs_count).toBe(2);

    // Job records: correlation propagated, statuses distinct, the failer carries its error.
    const winner = jobs.find((j) => j.job_name === 'winner')!;
    const failer = jobs.find((j) => j.job_name === 'failer')!;
    expect(winner.status).toBe('completed');
    expect(winner.result).toEqual({ ok: true });
    expect(failer.status).toBe('failed');
    expect(failer.error_message).toContain('kaboom');
    for (const j of jobs) {
      expect(j.correlation_id).toBe('corr-1');
      expect(j.event_execution_id).toBe(events[0].id); // job → event linkage
    }

    // ok is truthful: a failed job makes the invocation not-ok.
    expect(result.ok).toBe(false);

    // Normalized snapshot locks the full record schema (the Grafana/Console contract).
    expect({
      invocation: normalize(inv),
      events: normalize(events),
      jobs: normalize([...jobs].sort((a, b) => a.job_name.localeCompare(b.job_name))),
    }).toMatchSnapshot();
  });
});
