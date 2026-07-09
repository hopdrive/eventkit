// =============================================================================
// P1 "known holes" (testing-strategy.md §20, Wave 1)
// =============================================================================
// Small, named tests for behaviors the spec asserts but the suite didn't pin
// directly: correlation-id precedence end-to-end, timeout logs reaching onLog,
// rejectUnverified producing no invocation record (+ a framework warn), resolve
// permitted under a deferred-response platform, and the concurrency / warm-
// instance guards that turn the race()/warm-lambda concern into a permanent test.
import { describe, it, expect } from 'vitest';
import { createEventKit, defineEvent, job, asEventName, type EventModule, type EventKitPlugin, type JobContext } from '../../index.js';
import { fakeSource, defineFakeEvent, recordingPlugin, memorySink } from '../../testing/index.js';
import { hasuraEvent } from '../../plugins/source-hasura.js';
import { loopGuard, createTokenCodec } from '../../plugins/loop-guard/index.js';
import { observability } from '../../plugins/observability/index.js';
import { webhook } from '../../plugins/source-webhook/index.js';
import { netlifyBackgroundPlatform } from '../../plugins/platforms.js';

const UUID = '22222222-2222-2222-2222-222222222222';
const always = () => true;

const hasuraInsert = (newRow: Record<string, unknown>): unknown => ({
  id: 'evt',
  created_at: '2026-06-28T12:00:00.000Z',
  table: { schema: 'public', name: 'batch_jobs' },
  trigger: { name: 't' },
  event: { op: 'INSERT', data: { old: null, new: newRow }, session_variables: { 'x-hasura-role': 'admin' } },
});

describe('correlation-id precedence: inbound token BEATS source-derived BEATS fresh mint', () => {
  const cfg = { serviceId: 'svc-a', codec: { separator: '|', validateCorrelationId: true } };
  const capture = (sink: (corr: string) => void): EventModule =>
    ({ name: asEventName('e'), detector: hasuraEvent.detector(() => true), jobs: [job((c: JobContext) => void sink(c.correlationId))] } as EventModule);

  it('lifts the inbound token correlation (highest precedence)', async () => {
    let corr = '';
    const kit = createEventKit(hasuraEvent).use(loopGuard, cfg).registerEvents([capture(c => (corr = c))]);
    await kit.handle(hasuraInsert({ id: 1, updated_by: `origin-svc|${UUID}|origin-job` }));
    expect(corr).toBe(UUID); // the recovered chain id wins over anything the source would mint
  });

  it('falls back to the source-derived request.correlationId when there is no inbound token', async () => {
    let corr = '';
    const kit = createEventKit(hasuraEvent).use(loopGuard, cfg).registerEvents([capture(c => (corr = c))]);
    await kit.handle(hasuraInsert({ id: 1 }), { correlationId: 'req-supplied-corr' });
    expect(corr).toBe('req-supplied-corr'); // no token → the source folds in request.correlationId
  });

  it('mints a fresh id when neither an inbound token nor a request id is present', async () => {
    let a = '';
    let b = '';
    const kit = createEventKit(hasuraEvent).use(loopGuard, cfg).registerEvents([capture(c => (a = c))]);
    await kit.handle(hasuraInsert({ id: 1 }));
    const kit2 = createEventKit(hasuraEvent).use(loopGuard, cfg).registerEvents([capture(c => (b = c))]);
    await kit2.handle(hasuraInsert({ id: 2 }));
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b); // freshly minted per invocation, not a shared constant
  });

  it('keeps the lifted correlation stamped on the outbound token (chaining holds)', async () => {
    let outToken = '';
    const codec = createTokenCodec(cfg.codec);
    const mod = { name: asEventName('e'), detector: hasuraEvent.detector(() => true), jobs: [job((c: JobContext) => void (outToken = c.trackingToken))] } as EventModule;
    const kit = createEventKit(hasuraEvent).use(loopGuard, cfg).registerEvents([mod]);
    await kit.handle(hasuraInsert({ id: 1, updated_by: `origin-svc|${UUID}|origin-job` }));
    expect(codec.getCorrelationId(outToken)).toBe(UUID);
  });
});

describe('timeout logs reach onLog (§11.3 onLog breadth)', () => {
  it('a job cancelled by the serverless budget surfaces a framework log via onLog', async () => {
    const recorder = recordingPlugin();
    const mod = defineFakeEvent('e', always, [job(() => new Promise(resolve => setTimeout(resolve, 1000)), { name: 'longrunner' })]);
    const kit = createEventKit(fakeSource()).use(recorder.plugin).registerEvents([mod]);

    const result = await kit.handle('x', { getRemainingTimeMs: () => 250 }); // budget 50ms → abort
    expect(result.timedOut).toBe(true);

    // The timeout/cancellation is not silent: at least one onLog entry mentions it.
    const logged = recorder.calls
      .filter(c => c.hook === 'onLog')
      .map(c => String((c.args[0] as { message?: string })?.message ?? '').toLowerCase());
    expect(logged.some(m => /time|budget|cancel|deadline|abort/.test(m))).toBe(true);
  });
});

describe('rejectUnverified: NO invocation record + a framework warn', () => {
  it('a forged webhook produces zero observability invocation records and an onError/warn, with the configured status', async () => {
    const mem = memorySink();
    const recorder = recordingPlugin();
    const src = webhook({
      vendor: 'stripe',
      verify: args => args.headers['stripe-signature'] === 'good',
      rejectUnverified: { status: 403, message: 'forged' },
    });
    const mod = defineEvent({ name: 'stripe.any', detector: src.detector(() => true), jobs: [job(() => 'x', { name: 'work' })] });
    const kit = createEventKit(src).use(observability, { sink: mem }).use(recorder.plugin).registerEvents([mod]);

    const res = await kit.handle({ id: 1 }, { meta: { headers: { 'stripe-signature': 'forged' } } });

    expect(res.resolved?.error?.status).toBe(403); // configured wire status
    expect(res.events).toEqual([]); // detection/dispatch skipped
    expect(mem.invocations()).toEqual([]); // it never became an event → no invocation record
    // A pre-dispatch client rejection is logged (framework warn via onLog), so the drop is visible.
    const warned = recorder.calls.some(
      c => c.hook === 'onLog' && (c.args[0] as { level?: string })?.level === 'warn'
        && /reject|verif|client/i.test(String((c.args[0] as { message?: string })?.message ?? '')),
    );
    expect(warned).toBe(true);
  });
});

describe('resolve is permitted under a deferredResponse platform (respond is not)', () => {
  it('a resolve module validates + runs under netlifyBackgroundPlatform; a respond module is rejected at validate()', () => {
    // { json } = job-independent fixed reply → fine on a background/202 platform.
    const okMod = defineEvent({ name: 'bg.ok', detector: always, jobs: [job(() => 1)], response: { json: { received: true } } });
    const okKit = createEventKit(fakeSource()).use(netlifyBackgroundPlatform).registerEvents([okMod]);
    expect(() => okKit.validate()).not.toThrow();

    // { fromJobs } = result-driven → rejected, the response can't reflect jobs that haven't run.
    const badMod = defineEvent({ name: 'bg.bad', detector: always, jobs: [job(() => 1)], response: { fromJobs: () => 1 } });
    const badKit = createEventKit(fakeSource()).use(netlifyBackgroundPlatform).registerEvents([badMod]);
    expect(() => badKit.validate()).toThrow(/incompatible with platform/);
  });
});

describe('concurrency + warm-instance soak (race()/warm-lambda guards)', () => {
  it('two overlapping handle() calls on one kit do not cross-talk (distinct correlation ids + records)', async () => {
    const mem = memorySink();
    // Each invocation gets a fresh correlation id (fakeSource mints per-invocation).
    const mod = defineFakeEvent('e', always, [job(async (c: JobContext) => { await new Promise(r => setTimeout(r, 5)); return c.correlationId; }, { name: 'j' })]);
    const kit = createEventKit(fakeSource()).use(observability, { sink: mem }).registerEvents([mod]);

    const [a, b] = await Promise.all([kit.handle({ n: 1 }), kit.handle({ n: 2 })]);

    expect(a.invocationId).not.toBe(b.invocationId);
    // Records may be re-flushed idempotently (eager persist at job start); dedupe by
    // invocation id so we count DISTINCT invocations, not re-flushes.
    const invocations = [...new Map(mem.invocations().map(r => [r.id, r])).values()];
    const corrs = invocations.map(r => r.correlation_id);
    expect(corrs).toHaveLength(2);
    expect(new Set(corrs).size).toBe(2); // no shared/leaked correlation across the overlap
    // each flushed batch carries exactly its own single event (no cross-talk / leak)
    expect(mem.batches.every(batch => batch.events.length === 1)).toBe(true);
  });

  it('50 sequential handle() calls flush cleanly each time — the warm-instance buffer never leaks', async () => {
    const mem = memorySink();
    const mod = defineFakeEvent('e', always, [job(() => 'ok', { name: 'j' })]);
    const kit = createEventKit(fakeSource()).use(observability, { sink: mem }).registerEvents([mod]);

    for (let i = 0; i < 50; i++) await kit.handle({ n: i });

    // 50 DISTINCT invocations — the buffer is flushed AND cleared every time, so nothing
    // accumulates across warm invocations. (Records may be re-flushed idempotently by the
    // eager persist at job start, so dedupe invocation records by id before counting.)
    const invocations = [...new Map(mem.invocations().map(r => [r.id, r])).values()];
    expect(invocations).toHaveLength(50);
    // Every flushed batch carries exactly one event and one job — no leak across invocations.
    expect(mem.batches.every(batch => batch.events.length === 1 && batch.jobs.length === 1)).toBe(true);
  });
});
