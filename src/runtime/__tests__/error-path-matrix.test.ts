// =============================================================================
// Error-path chaos matrix (ADR-033 / testing-strategy.md §1 P0-A)
// =============================================================================
// Inject a throw at every seam of one invocation and assert the SAME invariants
// each time, so a future refactor of the dispatch loop is checked against the
// complete failure surface, not the handful of failures someone remembered:
//
//   1. `ok` is truthful (a swallowed failure must never report ok:true).
//   2. Retry semantics are correct for that seam:
//        framework-500  → result.error set, ok:false  (vendor retries)
//        client-status  → result.resolved.error set   (branded ClientError only)
//        isolate/normal → neither; the invocation proceeds and ok reflects jobs.
//   3. `onError` fired where the runtime routes the throw.
//   4. onInvocationEnd + onFlush ALWAYS ran (finally, ADR-033) — asserted via the
//      recording plugin's onFlush count and (where an invocation record exists)
//      its onInvocationEnd.
//   5. The result is always a well-formed InvocationResult.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { createEventKit, defineEvent, job, ClientError } from '../../index.js';
import type { EventKitPlugin, EventEnvelope, RequestContext } from '../../index.js';
import { fakeSource, recordingPlugin, type RecordingPlugin } from '../../testing/index.js';

interface Wired {
  kit: ReturnType<typeof createEventKit>;
  recorder: RecordingPlugin;
  /** Set by seams that assert the invocation still reached a job (isolate-and-continue). */
  jobRan: () => boolean;
}

type Wire = 'framework-500' | 'client-status' | 'normal';

interface Row {
  seam: string;
  build: () => Wired;
  ok: boolean;
  wire: Wire;
  onError: boolean;
  /** true when the invocation must still run its job despite the throw. */
  continues?: boolean;
  /** true when an Invocation record is produced (pre-dispatch rejects produce none). */
  hasInvocationRecord?: boolean;
}

const BOOM = new Error('boom');
// typing helper for handler() results in this file
declare function kitHandle(): ReturnType<ReturnType<typeof createEventKit>['handle']>;

/** A module with one marker job so we can prove isolate-and-continue actually ran it. */
function markerModule(ran: { value: boolean }) {
  return defineEvent({
    name: 'test.marker',
    detector: () => true,
    jobs: [job(() => { ran.value = true; return 'ok'; }, { name: 'marker' })],
  });
}

const rows: Row[] = [
  {
    seam: 'configureInvocation throws (delta transform → isolate & continue)',
    ok: true, wire: 'normal', onError: true, continues: true, hasInvocationRecord: true,
    build() {
      const ran = { value: false };
      const bad: EventKitPlugin = { name: 'bad-configure', configureInvocation() { throw BOOM; } };
      const recorder = recordingPlugin();
      const kit = createEventKit(fakeSource()).use(bad).use(recorder.plugin).registerEvents([markerModule(ran)]);
      return { kit, recorder, jobRan: () => ran.value };
    },
  },
  {
    seam: 'augmentEnvelope throws (delta transform → isolate & continue)',
    ok: true, wire: 'normal', onError: true, continues: true, hasInvocationRecord: true,
    build() {
      const ran = { value: false };
      const bad: EventKitPlugin = { name: 'bad-augment', augmentEnvelope(): Partial<EventEnvelope> { throw BOOM; } };
      const recorder = recordingPlugin();
      const kit = createEventKit(fakeSource()).use(bad).use(recorder.plugin).registerEvents([markerModule(ran)]);
      return { kit, recorder, jobRan: () => ran.value };
    },
  },
  {
    seam: 'detector throws (per-event isolate; crash surfaced, ok stays job-only)',
    ok: true, wire: 'normal', onError: true, continues: false, hasInvocationRecord: true,
    build() {
      const recorder = recordingPlugin();
      const mod = defineEvent({ name: 'test.detcrash', detector: () => { throw BOOM; }, jobs: [job(() => 'x', { name: 'j' })] });
      const kit = createEventKit(fakeSource()).use(recorder.plugin).registerEvents([mod]);
      return { kit, recorder, jobRan: () => false };
    },
  },
  {
    seam: 'prepare throws (crash surfaced; no jobs run; ok stays job-only)',
    ok: true, wire: 'normal', onError: true, continues: false, hasInvocationRecord: true,
    build() {
      const recorder = recordingPlugin();
      const mod = defineEvent({
        name: 'test.prepcrash',
        detector: () => true,
        prepare: () => { throw BOOM; },
        jobs: [job(() => 'x', { name: 'j' })],
      });
      const kit = createEventKit(fakeSource()).use(recorder.plugin).registerEvents([mod]);
      return { kit, recorder, jobRan: () => false };
    },
  },
  {
    seam: 'job body throws (isolated failure; ok:false, no framework error)',
    ok: false, wire: 'normal', onError: true, continues: false, hasInvocationRecord: true,
    build() {
      const recorder = recordingPlugin();
      const mod = defineEvent({ name: 'test.jobcrash', detector: () => true, jobs: [job(() => { throw BOOM; }, { name: 'j' })] });
      const kit = createEventKit(fakeSource()).use(recorder.plugin).registerEvents([mod]);
      return { kit, recorder, jobRan: () => false };
    },
  },
  {
    seam: 'onJobStart notification throws (fan-out swallows → onError; continues)',
    ok: true, wire: 'normal', onError: true, continues: true, hasInvocationRecord: true,
    build() {
      const ran = { value: false };
      const bad: EventKitPlugin = { name: 'bad-onjobstart', onJobStart() { throw BOOM; } };
      const recorder = recordingPlugin();
      const kit = createEventKit(fakeSource()).use(bad).use(recorder.plugin).registerEvents([markerModule(ran)]);
      return { kit, recorder, jobRan: () => ran.value };
    },
  },
  {
    seam: 'onFlush notification throws (best-effort; routed to onError, never masks the result)',
    ok: true, wire: 'normal', onError: true, continues: true, hasInvocationRecord: true,
    build() {
      const ran = { value: false };
      const bad: EventKitPlugin = { name: 'bad-onflush', onFlush() { throw BOOM; } };
      const recorder = recordingPlugin();
      const kit = createEventKit(fakeSource()).use(bad).use(recorder.plugin).registerEvents([markerModule(ran)]);
      return { kit, recorder, jobRan: () => ran.value };
    },
  },
  {
    seam: 'normalize throws a plain error (framework 500 → vendor retries)',
    ok: false, wire: 'framework-500', onError: true, continues: false, hasInvocationRecord: false,
    build() {
      const src = fakeSource();
      src.normalize = () => { throw BOOM; };
      const recorder = recordingPlugin();
      const kit = createEventKit(src).use(recorder.plugin).registerEvents([markerModule({ value: false })]);
      return { kit, recorder, jobRan: () => false };
    },
  },
  {
    seam: 'normalize throws a branded ClientError (client status, skip dispatch)',
    ok: true, wire: 'client-status', onError: false, continues: false, hasInvocationRecord: false,
    build() {
      const src = fakeSource();
      src.normalize = (_raw: unknown, _req: RequestContext): EventEnvelope => { throw new ClientError(401, 'forged'); };
      const recorder = recordingPlugin();
      const kit = createEventKit(src).use(recorder.plugin).registerEvents([markerModule({ value: false })]);
      return { kit, recorder, jobRan: () => false };
    },
  },
];

describe('error-path chaos matrix (ADR-033)', () => {
  for (const row of rows) {
    it(row.seam, async () => {
      const { kit, recorder, jobRan } = row.build();
      const result = await kit.handle({ hello: 'world' });

      // (5) well-formed result
      expect(typeof result.ok).toBe('boolean');
      expect(result.invocationId).toBeTruthy();
      expect(Array.isArray(result.events)).toBe(true);

      // (1) ok is truthful
      expect(result.ok).toBe(row.ok);

      // (2) retry semantics / wire mapping
      if (row.wire === 'framework-500') {
        expect(result.error).toBeDefined();
        expect(result.resolved?.error).toBeUndefined();
      } else if (row.wire === 'client-status') {
        expect(result.error).toBeUndefined();
        expect(result.resolved?.error).toBeDefined();
      } else {
        expect(result.error).toBeUndefined();
        expect(result.resolved?.error).toBeUndefined();
      }

      // (3) onError routed where expected
      expect(recorder.errors.length > 0).toBe(row.onError);

      // (4) onFlush ALWAYS ran; onInvocationEnd ran iff an invocation record exists
      expect(recorder.flushCount()).toBeGreaterThanOrEqual(1);
      expect(recorder.sequence().includes('onInvocationEnd')).toBe(row.hasInvocationRecord === true);

      // isolate-and-continue seams still reach their job
      if (row.continues) expect(jobRan()).toBe(true);
    });
  }
});

// =============================================================================
// Crash-policy: 'signalRetry' (ADR-038)
// =============================================================================
// The matrix above pins the framework DEFAULT ('ack'): a detector/prepare crash
// stays in events[].error, the invocation still returns 200 (result.error unset),
// and an at-least-once sender does NOT retry. A source that carries at-least-once
// semantics (webhook) flips crashPolicy to 'signalRetry': the SAME processing crash
// is escalated to a top-level framework error → 500 → the sender retries, AND a loud
// error log is emitted (Grafana visibility) on top of the onError route (Sentry).
// A deliberate resolve/respond reply is NOT a crash — it still maps to its client
// status. A job failure is not a processing crash either — it stays a 200.
describe("crash-policy 'signalRetry' (ADR-038)", () => {
  const signalRetrySource = () => {
    const src = fakeSource();
    src.crashPolicy = 'signalRetry';
    return src;
  };

  const hasEscalationLog = (recorder: RecordingPlugin) =>
    recorder.calls.some(
      c => c.hook === 'onLog' && (c.args[0] as { level?: string; message?: string })?.level === 'error'
        && String((c.args[0] as { message?: string })?.message ?? '').includes('escalated'),
    );

  it('detector crash → framework 500 (ok:false, result.error set) + loud error log', async () => {
    const recorder = recordingPlugin();
    const mod = defineEvent({ name: 'test.detcrash', detector: () => { throw BOOM; }, jobs: [job(() => 'x', { name: 'j' })] });
    const kit = createEventKit(signalRetrySource()).use(recorder.plugin).registerEvents([mod]);

    const result = await kit.handle({ hello: 'world' });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.resolved?.error).toBeUndefined();
    expect(recorder.errors.length).toBeGreaterThan(0); // onError (Sentry) still routed
    expect(hasEscalationLog(recorder)).toBe(true); // loud log (Grafana)
  });

  it('prepare crash → framework 500 (ok:false, result.error set)', async () => {
    const recorder = recordingPlugin();
    const mod = defineEvent({
      name: 'test.prepcrash',
      detector: () => true,
      prepare: () => { throw BOOM; },
      jobs: [job(() => 'x', { name: 'j' })],
    });
    const kit = createEventKit(signalRetrySource()).use(recorder.plugin).registerEvents([mod]);

    const result = await kit.handle({ hello: 'world' });

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.resolved?.error).toBeUndefined();
    expect(hasEscalationLog(recorder)).toBe(true);
  });

  it("a handler-level `after` is SKIPPED when a crash escalates — the 500 reaches the wire", async () => {
    const recorder = recordingPlugin();
    const mod = defineEvent({
      name: 'test.detectorcrash',
      detector: () => { throw BOOM; },
      jobs: [job(() => 'ok', { name: 'marker' })],
    });
    const handler = createEventKit(signalRetrySource())
      .use(recorder.plugin)
      .registerEvents([mod])
      .handler({ after: { static: { received: true } } });

    const result = (await handler({ hello: 'world' })) as Awaited<ReturnType<typeof kitHandle>>;

    expect(result.error).toBeDefined(); // escalated to a retryable framework error
    expect(result.resolved).toBeUndefined(); // the constant ack did NOT mask the 500
    expect(hasEscalationLog(recorder)).toBe(true);
  });

  it('job failure is NOT escalated — a business failure stays a 200 (own retry)', async () => {
    const recorder = recordingPlugin();
    const mod = defineEvent({ name: 'test.jobcrash', detector: () => true, jobs: [job(() => { throw BOOM; }, { name: 'j' })] });
    const kit = createEventKit(signalRetrySource()).use(recorder.plugin).registerEvents([mod]);

    const result = await kit.handle({ hello: 'world' });

    expect(result.ok).toBe(false); // job failed
    expect(result.error).toBeUndefined(); // but not a framework 500
    expect(hasEscalationLog(recorder)).toBe(false);
  });
});
