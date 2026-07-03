// Tests for the published ./testing harness (ADR-036). These exercise the harness
// THROUGH the real runtime — the same guarantee the harness gives consumers.
import { describe, it, expect } from 'vitest';
import { createEventKit, defineEvent, job, asEventName, type EventModule, type JobContext } from '../../index.js';
import { hasuraEvent } from '../../plugins/source-hasura.js';
import { webhook, hmacVerify } from '../../plugins/source-webhook/index.js';
import { loopGuard } from '../../plugins/loop-guard/index.js';
import { batch } from '../../plugins/batch/index.js';
import {
  hasuraInsert,
  hasuraUpdate,
  hasuraManualEdit,
  hasuraCronPayload,
  hasuraActionPayload,
  webhookRequest,
  testInvocation,
  detectorContract,
  memoryBatchStore,
  capturedLogger,
  simulateChain,
  expectFlow,
  assertObservedWithinFlow,
  observedFlowNodes,
} from '../index.js';

const hasuraKit = () => {
  const mod = defineEvent({
    name: 'appt.ready',
    detector: hasuraEvent.detector<{ status?: string }>(ctx => ctx.operation === 'INSERT' && ctx.newRow?.status === 'ready'),
    jobs: [job(() => 'sent', { name: 'notify' })],
  });
  return createEventKit(hasuraEvent).registerEvents([mod]);
};

describe('payload builders + testInvocation', () => {
  it('hasuraInsert fires a matching detector; testInvocation surfaces the fired event + job', async () => {
    const t = await testInvocation(hasuraKit(), hasuraInsert('appointments', { id: 1, status: 'ready' }));
    expect(t.firedEvents).toEqual(['appt.ready']);
    expect(t.job('notify')?.status).toBe('completed');
    expect(t.job('notify')?.output).toBe('sent');
    expect(t.ok).toBe(true);
    // observability records are captured (the schema contract)
    expect(t.records.invocations).toHaveLength(1);
    expect(t.records.jobs).toHaveLength(1);
    expect(t.records.jobs[0]!.job_name ?? t.records.jobs[0]!.jobName).toBeDefined();
  });

  it('hasuraUpdate with updatedBy stamps the loop-guard field on the new row', async () => {
    let seen: unknown;
    const mod = defineEvent({
      name: 'e',
      detector: hasuraEvent.detector(() => true),
      jobs: [job((c: JobContext) => void (seen = (c.envelope.payload as { event?: { data?: { new?: { updated_by?: string } } } })?.event?.data?.new?.updated_by))],
    });
    const kit = createEventKit(hasuraEvent).registerEvents([mod]);
    await testInvocation(kit, hasuraUpdate('moves', { id: 1 }, { id: 1 }, { updatedBy: 'svc|corr|job' }));
    expect(seen).toBe('svc|corr|job');
  });

  it('hasuraCronPayload / hasuraActionPayload build the expected shapes', () => {
    const cron = hasuraCronPayload('nightly', '2026-01-01T00:00:00.000Z', { batch: 1 }) as { name: string; scheduled_time: string };
    expect(cron.name).toBe('nightly');
    expect(cron.scheduled_time).toBe('2026-01-01T00:00:00.000Z');
    const action = hasuraActionPayload('doThing', { x: 1 }) as { action: { name: string }; input: { x: number } };
    expect(action.action.name).toBe('doThing');
    expect(action.input.x).toBe(1);
  });

  it('webhookRequest().signWith produces a signature hmacVerify accepts', async () => {
    const secret = 'whsec_test';
    const req = webhookRequest({ vendor: 'stripe', body: { id: 'evt_1' } }).signWith(secret);
    let verified: boolean | undefined;
    const src = webhook({ vendor: 'stripe', verify: hmacVerify({ secret }) });
    const mod = defineEvent({
      name: 'stripe.any',
      detector: src.detector(ctx => { verified = ctx.signatureVerified; return true; }),
      jobs: [job(() => {})],
    });
    await testInvocation(createEventKit(src).registerEvents([mod]), req);
    expect(verified).toBe(true);
  });
});

describe('detectorContract', () => {
  const mod = (): EventModule =>
    defineEvent({
      name: 'appt.ready',
      detector: hasuraEvent.detector<{ status?: string }>(ctx => ctx.operation === 'INSERT' && ctx.newRow?.status === 'ready'),
      jobs: [job(() => {})],
    }) as EventModule;

  it('passes when fires/suppresses hold, and auto-appends the MANUAL suppress case for hasura', async () => {
    const report = await detectorContract(hasuraEvent, mod(), {
      fires: [hasuraInsert('appointments', { status: 'ready' })],
      suppresses: [hasuraInsert('appointments', { status: 'pending' })],
    });
    expect(report.ok).toBe(true);
    expect(report.ran).toBe(3); // 1 fires + 1 suppresses + 1 auto-MANUAL
  });

  it('throws a readable report when a case fails', async () => {
    await expect(
      detectorContract(hasuraEvent, mod(), { fires: [hasuraInsert('appointments', { status: 'pending' })], suppresses: [] }),
    ).rejects.toThrow(/fires\[0\] expected detector=true/);
  });

  it('the auto-MANUAL case catches a detector that fires on a console edit (D17)', async () => {
    const leaky = defineEvent({
      name: 'leaky',
      detector: hasuraEvent.detector(() => true), // no operation guard → fires on everything, incl. MANUAL
      jobs: [job(() => {})],
    }) as EventModule;
    await expect(
      detectorContract(hasuraEvent, leaky, { fires: [], suppresses: [] }),
    ).rejects.toThrow(/suppresses/);
  });
});

describe('memory doubles', () => {
  it('memoryBatchStore records the batch plugin update() calls', async () => {
    const store = memoryBatchStore();
    const mod = defineEvent({
      name: 'e',
      detector: hasuraEvent.detector(() => true),
      jobs: [job(() => 'ok', { name: 'work' })],
    });
    const kit = createEventKit(hasuraEvent).use(batch, { store }).registerEvents([mod]);
    await testInvocation(kit, hasuraInsert('batch_jobs', { id: 42 }));
    expect(store.updates.length).toBeGreaterThan(0);
    expect(store.updates.some(u => u.fields.status === 'complete' || u.fields.status === 'completed' || !!u.fields.status)).toBe(true);
  });

  it('capturedLogger captures entries by level', () => {
    const log = capturedLogger();
    log.info('hello', { a: 1 });
    log.error('boom', new Error('x'));
    expect(log.entries.map(e => e.level)).toEqual(['info', 'error']);
    expect(log.entries[0]!.data).toEqual({ a: 1 });
    expect(log.entries[1]!.error).toBeInstanceOf(Error);
  });
});

describe('simulateChain (correlation continuity, ADR-028)', () => {
  const cfg = { serviceId: 'svc-a', codec: { separator: '|', validateCorrelationId: true } };
  const chainKit = () => {
    const mod = { name: asEventName('e'), detector: hasuraEvent.detector(() => true), jobs: [job(() => 'ok', { name: 'j' })] } as EventModule;
    return createEventKit(hasuraEvent).use(loopGuard, cfg).registerEvents([mod]);
  };

  it('the child rejoins the parent chain when it echoes the token (continuity holds)', async () => {
    const res = await simulateChain(
      chainKit(),
      hasuraInsert('moves', { id: 1 }),
      chainKit(),
      ({ correlationId, jobId }) => hasuraUpdate('moves', { id: 1 }, { id: 1 }, { updatedBy: `svc-a|${correlationId}|${jobId}` }),
    );
    expect(res.parentCorrelationId).toBeTruthy();
    expect(res.continuous).toBe(true);
    expect(res.childCorrelationId).toBe(res.parentCorrelationId);
  });

  it('a child that ignores the link starts a clean root (continuity false)', async () => {
    const res = await simulateChain(
      chainKit(),
      hasuraInsert('moves', { id: 1 }),
      chainKit(),
      () => hasuraInsert('moves', { id: 2 }), // no echoed token → fresh correlation
    );
    expect(res.continuous).toBe(false);
    expect(res.childCorrelationId).not.toBe(res.parentCorrelationId);
  });
});

describe('expectFlow', () => {
  it('asserts events and their static job sets from kit.describe()', () => {
    const mod = defineEvent({
      name: 'appt.ready',
      detector: hasuraEvent.detector(() => true),
      jobs: [job(() => {}, { name: 'notify' }), job(() => {}, { name: 'email' })],
    });
    const kit = createEventKit(hasuraEvent).registerEvents([mod]);
    expectFlow(kit).hasEvents('appt.ready').event('appt.ready').exists().hasJobs('notify', 'email').hasJob('email').respondsWith('none');
  });

  it('throws on a job-set mismatch', () => {
    const mod = defineEvent({ name: 'e', detector: hasuraEvent.detector(() => true), jobs: [job(() => {}, { name: 'a' })] });
    const kit = createEventKit(hasuraEvent).registerEvents([mod]);
    expect(() => expectFlow(kit).event('e').hasJobs('a', 'b')).toThrow(/mismatch/);
  });

  it('throws on unknown event, event-set mismatch, missing job, and wrong response kind', () => {
    const mod = defineEvent({ name: 'e', detector: hasuraEvent.detector(() => true), jobs: [job(() => {}, { name: 'a' })] });
    const kit = createEventKit(hasuraEvent).registerEvents([mod]);
    expect(() => expectFlow(kit).event('nope').exists()).toThrow(/no such event/);
    expect(() => expectFlow(kit).hasEvents('e', 'other')).toThrow(/events mismatch/);
    expect(() => expectFlow(kit).event('e').hasJob('missing')).toThrow(/not found/);
    expect(() => expectFlow(kit).event('e').respondsWith('resolve')).toThrow(/response is 'none'/);
    // happy accessors
    expect(expectFlow(kit).eventNames()).toEqual(['e']);
    expect(expectFlow(kit).event('e').jobNames()).toEqual(['a']);
  });
});

describe('proto-Compare: assertObservedWithinFlow (ADR-037)', () => {
  it('a real invocation produces only nodes present in the expected flow graph', async () => {
    const mod = defineEvent({
      name: 'appt.ready',
      detector: hasuraEvent.detector<{ status?: string }>(ctx => ctx.newRow?.status === 'ready'),
      jobs: [job(() => {}, { name: 'notify' })],
    });
    const kit = createEventKit(hasuraEvent).registerEvents([mod]);
    const t = await testInvocation(kit, hasuraInsert('appointments', { status: 'ready' }));

    expect(observedFlowNodes(t)).toEqual(['event:appt.ready', 'job:appt.ready:notify']);
    const cmp = assertObservedWithinFlow(kit, t);
    expect(cmp.ok).toBe(true);
    expect(cmp.unexpected).toEqual([]);
  });
});
