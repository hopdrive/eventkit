import { describe, it, expect } from 'vitest';
import { createEventKit, run, job, asEventName, type EventModule, type JobContext } from '../../index.js';
import { fakeSource, defineFakeEvent } from '../../testing/index.js';
import { hasuraEvent } from '../../sources/hasura/index.js';
import { loopPrevention, createTokenCodec } from '../loop-prevention/index.js';
import { observability, type ObservabilityBatch } from '../observability/index.js';
import { batchJobs, type BatchJobUpdate } from '../batchjobs/index.js';
import { grafanaTransport, type LokiPayload } from '../transports/grafana/index.js';
import { sentry, type SentryEvent } from '../transports/sentry/index.js';

const UUID = '11111111-1111-1111-1111-111111111111';

// Minimal Hasura DB-event payload builder.
function hasuraInsert(newRow: Record<string, unknown>): unknown {
  return {
    id: 'evt',
    created_at: '2026-06-28T12:00:00.000Z',
    table: { schema: 'public', name: 'batch_jobs' },
    trigger: { name: 't' },
    event: { op: 'INSERT', data: { old: null, new: newRow }, session_variables: { 'x-hasura-role': 'admin' } },
  };
}

describe('loopPrevention', () => {
  const cfg = { field: 'updated_by', serviceId: 'svc-a', codec: { separator: '|', validateCorrelationId: true } };

  it('round-trips an inbound token: meta.sourceTrackingToken in, lineage-preserving ctx.trackingToken out', async () => {
    const inbound = `origin-svc|${UUID}|origin-job`;
    let metaToken: unknown;
    let outToken = '';
    let jobId = '';
    const mod = defineFakeEvent('e', () => true, (event, _ctx) =>
      run(event, [
        job((c: JobContext) => {
          metaToken = c.envelope.meta['sourceTrackingToken'];
          outToken = c.trackingToken;
          jobId = c.job.id;
        }),
      ]),
    );
    // Use the Hasura source so the default reader finds new.updated_by.
    const kit = createEventKit(hasuraEvent).use(loopPrevention, cfg).registerEvents([
      { name: asEventName('e'), detector: mod.detector, handler: mod.handler } as EventModule,
    ]);
    await kit.handle(hasuraInsert({ id: 1, updated_by: inbound }));

    const codec = createTokenCodec(cfg.codec);
    expect(metaToken).toBe(inbound); // inbound lifted into envelope.meta
    // outbound keeps source + correlation, swaps in this job's id
    expect(codec.getSource(outToken)).toBe('origin-svc');
    expect(codec.getCorrelationId(outToken)).toBe(UUID);
    expect(codec.getJobExecutionId(outToken)).toBe(jobId);
  });

  it('mints a fresh token from serviceId when there is no inbound token', async () => {
    let outToken = '';
    let correlationId = '';
    const mod = defineFakeEvent('e', () => true, (event, _ctx) =>
      run(event, [
        job((c: JobContext) => {
          outToken = c.trackingToken;
          correlationId = c.correlationId;
        }),
      ]),
    );
    const kit = createEventKit(hasuraEvent).use(loopPrevention, cfg).registerEvents([
      { name: asEventName('e'), detector: mod.detector, handler: mod.handler } as EventModule,
    ]);
    await kit.handle(hasuraInsert({ id: 1 })); // no updated_by

    const codec = createTokenCodec(cfg.codec);
    expect(codec.getSource(outToken)).toBe('svc-a');
    expect(codec.getCorrelationId(outToken)).toBe(correlationId);
  });

  it('a self-originated write is recognizable for suppression', async () => {
    const selfToken = `svc-a|${UUID}|prev-job`;
    let suppressed = false;
    const codec = createTokenCodec({ separator: '|', validateCorrelationId: true });
    const mod = defineFakeEvent('e', () => true, (event, ctx) => {
      const inbound = ctx.envelope.meta['sourceTrackingToken'];
      suppressed = typeof inbound === 'string' && codec.getSource(inbound) === 'svc-a';
      return run(event, []);
    });
    const kit = createEventKit(hasuraEvent).use(loopPrevention, cfg).registerEvents([
      { name: asEventName('e'), detector: mod.detector, handler: mod.handler } as EventModule,
    ]);
    await kit.handle(hasuraInsert({ id: 1, updated_by: selfToken }));
    expect(suppressed).toBe(true);
  });
});

describe('observability', () => {
  it('flushes one batch per invocation with invocation/event/job records', async () => {
    const batches: ObservabilityBatch[] = [];
    const mod = defineFakeEvent('thing.happened', () => true, (event, _ctx) =>
      run(event, [job(() => 'ok', { name: 'good' }), job(() => { throw new Error('x'); }, { name: 'bad' })]),
    );
    const kit = createEventKit(fakeSource()).use(observability, { sink: (b: ObservabilityBatch) => void batches.push(b) }).registerEvents([mod]);

    await kit.handle('go');
    await kit.handle('go');

    expect(batches).toHaveLength(2);
    expect(batches[0]!.invocation.invocationId).not.toBe(batches[1]!.invocation.invocationId);
    expect(batches[0]!.events).toHaveLength(1);
    expect(batches[0]!.events[0]!.eventName).toBe('thing.happened');
    expect(batches[0]!.jobs.map(j => j.status).sort()).toEqual(['completed', 'failed']);
  });

  it('does not record events that never fired', async () => {
    const batches: ObservabilityBatch[] = [];
    const mod = defineFakeEvent('never', () => false, (event, _ctx) => run(event, []));
    const kit = createEventKit(fakeSource()).use(observability, { sink: (b: ObservabilityBatch) => void batches.push(b) }).registerEvents([mod]);
    await kit.handle('x');
    expect(batches[0]!.events).toHaveLength(0);
  });
});

describe('batchJobs', () => {
  const buildKit = (store: { update: (id: string | number, f: BatchJobUpdate) => void }) => {
    const detector = hasuraEvent.detector(ctx => ctx.operation === 'INSERT');
    const handler = hasuraEvent.handler((event, _ctx) => run(event, [job(capture, { name: 'proc' })]));
    return createEventKit(hasuraEvent)
      .use(batchJobs, { store })
      .registerEvents([{ name: asEventName('batch.created'), detector, handler } as EventModule]);
  };
  let captured: Record<string, unknown> | undefined;
  const capture = (ctx: JobContext) => {
    captured = ctx.input as Record<string, unknown>;
    return { processed: true };
  };

  it('injects the row input and persists processing → done', async () => {
    captured = undefined;
    const updates: Array<{ id: string | number; fields: BatchJobUpdate }> = [];
    const kit = buildKit({ update: (id, fields) => void updates.push({ id, fields }) });
    await kit.handle(hasuraInsert({ id: 'row-1', input: { workUnit: 'W' }, status: 'pending' }));

    expect(captured).toEqual({ workUnit: 'W' }); // injected from the batch_jobs row
    const statuses = updates.filter(u => u.fields.status).map(u => u.fields.status);
    expect(statuses).toContain('processing');
    expect(statuses).toContain('done');
    const done = updates.find(u => u.fields.status === 'done');
    expect(done!.id).toBe('row-1');
    expect(done!.fields.output).toEqual({ processed: true });
  });

  it('handler input overrides the row baseline (handler keys win)', async () => {
    captured = undefined;
    const detector = hasuraEvent.detector(ctx => ctx.operation === 'INSERT');
    const handler = hasuraEvent.handler((event, _ctx) =>
      run(event, [job(capture, { name: 'proc', input: { workUnit: 'override' } })]),
    );
    const kit = createEventKit(hasuraEvent)
      .use(batchJobs, { store: { update: () => {} } })
      .registerEvents([{ name: asEventName('batch.created'), detector, handler } as EventModule]);
    await kit.handle(hasuraInsert({ id: 'row-2', input: { workUnit: 'W' } }));
    expect(captured).toEqual({ workUnit: 'override' });
  });

  it('throws at validate() when the Hasura source is absent (requires: source:hasura)', () => {
    const detector = fakeSource().detector(() => true);
    const handler = fakeSource().handler((event, _ctx) => run(event, []));
    const kit = createEventKit(fakeSource())
      .use(batchJobs, { store: { update: () => {} } })
      .registerEvents([{ name: asEventName('e'), detector, handler } as unknown as EventModule]);
    expect(() => kit.validate()).toThrow(/source:hasura/);
  });
});

describe('transports/grafana', () => {
  it('buffers job logs and flushes a Loki payload via the injected sender', async () => {
    const payloads: LokiPayload[] = [];
    const mod = defineFakeEvent('e', () => true, (event, _ctx) =>
      run(event, [job((c: JobContext) => void c.log.info('hello from job', { n: 1 }), { name: 'j' })]),
    );
    const kit = createEventKit(fakeSource())
      .use(grafanaTransport, { endpoint: 'http://loki', labels: { app: 'test' }, send: (p: LokiPayload) => void payloads.push(p) })
      .registerEvents([mod]);
    await kit.handle('go');

    expect(payloads).toHaveLength(1);
    const values = payloads[0]!.streams[0]!.values;
    expect(payloads[0]!.streams[0]!.stream).toMatchObject({ app: 'test' });
    expect(values.some(([, line]) => line.includes('hello from job'))).toBe(true);
  });
});

describe('transports/sentry', () => {
  it('forwards a handler crash to the injected sender', async () => {
    const events: SentryEvent[] = [];
    const mod = defineFakeEvent('e', () => true, () => {
      throw new Error('kaboom');
    });
    const kit = createEventKit(fakeSource())
      .use(sentry, { dsn: 'http://sentry', send: (e: SentryEvent) => void events.push(e) })
      .registerEvents([mod]);
    await kit.handle('go');

    expect(events).toHaveLength(1);
    expect(events[0]!.exception.value).toBe('kaboom');
    expect(events[0]!.tags.phase).toBe('handle');
  });
});
