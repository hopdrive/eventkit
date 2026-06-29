import { describe, it, expect } from 'vitest';
import { createEventKit, run, job, asEventName, type EventModule, type JobContext } from '../../index.js';
import { fakeSource, defineFakeEvent } from '../../testing/index.js';
import { hasuraEvent } from '../../sources/hasura/index.js';
import { loopPrevention, createTokenCodec } from '../loop-prevention/index.js';
import { observability, type ObservabilityBatch } from '../observability/index.js';
import { graphqlSink } from '../observability/graphql-sink.js';
import { safeSerialize } from '../observability/serialize.js';
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
  it('flushes one batch per invocation with the canonical record field set', async () => {
    const batches: ObservabilityBatch[] = [];
    const mod = defineFakeEvent('thing.happened', () => true, (event, _ctx) =>
      run(event, [
        job(() => 'ok', { name: 'good', metadata: { tier: 1 } }),
        job(() => { throw new Error('x'); }, { name: 'bad' }),
      ]),
    );
    const kit = createEventKit(fakeSource()).use(observability, { sink: (b: ObservabilityBatch) => void batches.push(b) }).registerEvents([mod]);

    await kit.handle('go');
    await kit.handle('go');

    expect(batches).toHaveLength(2);
    const b = batches[0]!;
    expect(b.invocation.id).not.toBe(batches[1]!.invocation.id);
    expect(b.invocation.source_system).toBe('fake');
    expect(b.invocation.status).toBe('failed'); // one job failed
    expect(b.invocation.total_jobs_run).toBe(2);
    expect(b.invocation.total_jobs_succeeded).toBe(1);
    expect(b.invocation.total_jobs_failed).toBe(1);
    expect(b.invocation.events_detected_count).toBe(1);

    expect(b.events).toHaveLength(1);
    expect(b.events[0]!.event_name).toBe('thing.happened');
    expect(b.events[0]!.jobs_count).toBe(2);
    expect(b.events[0]!.jobs_succeeded).toBe(1);

    expect(b.jobs.map(j => j.status).sort()).toEqual(['completed', 'failed']);
    const good = b.jobs.find(j => j.job_name === 'good')!;
    expect(good.event_execution_id).toBe(b.events[0]!.id); // job linked to its event
    expect(good.job_function_name).toBe('good');
    expect(good.job_options).toEqual({ tier: 1 }); // serializable metadata captured
    expect(good.result).toBe('ok');
    expect(b.jobs.find(j => j.job_name === 'bad')!.error_message).toBe('x');
  });

  it('captures source attributes from envelope.meta (Hasura) and the prior-job link', async () => {
    const batches: ObservabilityBatch[] = [];
    const detector = hasuraEvent.detector(ctx => ctx.operation === 'INSERT');
    const handler = hasuraEvent.handler((event, _ctx) => run(event, []));
    const kit = createEventKit(hasuraEvent)
      .use(loopPrevention, { field: 'updated_by', codec: { separator: '|', validateCorrelationId: true } })
      .use(observability, { sink: (bb: ObservabilityBatch) => void batches.push(bb) })
      .registerEvents([{ name: asEventName('batch.created'), detector, handler } as EventModule]);
    await kit.handle(hasuraInsert({ id: 1, updated_by: `prior-svc|${UUID}|prior-job-9` }));

    const inv = batches[0]!.invocation;
    expect(inv.source_system).toBe('hasura');
    expect(inv.source_table).toBe('public.batch_jobs');
    expect(inv.source_operation).toBe('INSERT');
    expect(inv.source_job_id).toBe('prior-job-9'); // loop-prevention surfaced the prior job link
  });

  it('records a handler crash on the invocation (onError) without failing execution', async () => {
    const batches: ObservabilityBatch[] = [];
    const mod = defineFakeEvent('e', () => true, () => { throw new Error('handler boom'); });
    const kit = createEventKit(fakeSource()).use(observability, { sink: (b: ObservabilityBatch) => void batches.push(b) }).registerEvents([mod]);
    const result = await kit.handle('x');
    expect(result.ok).toBe(true); // no-retry contract
    expect(batches[0]!.invocation.status).toBe('failed');
    expect(batches[0]!.invocation.error_message).toBe('handler boom');
  });

  it('does not record events that never fired', async () => {
    const batches: ObservabilityBatch[] = [];
    const mod = defineFakeEvent('never', () => false, (event, _ctx) => run(event, []));
    const kit = createEventKit(fakeSource()).use(observability, { sink: (b: ObservabilityBatch) => void batches.push(b) }).registerEvents([mod]);
    await kit.handle('x');
    expect(batches[0]!.events).toHaveLength(0);
  });
});

describe('observability: parent-child linkage (the capability behind the dropped jobExecutionId mutation)', () => {
  const codec = createTokenCodec({ separator: '|', validateCorrelationId: true });
  const lpCfg = { field: 'updated_by', serviceId: 'svc', codec: { separator: '|', validateCorrelationId: true } };

  it('the persisted job row id, the outbound token job segment, and the next invocation source_job_id all agree', async () => {
    // ── Invocation A: run a job, capture its observability row id + outbound token ──
    const aBatches: ObservabilityBatch[] = [];
    let outboundToken = '';
    const detA = hasuraEvent.detector(c => c.operation === 'INSERT');
    const handA = hasuraEvent.handler((event, _ctx) =>
      run(event, [job((c: JobContext) => void (outboundToken = c.trackingToken), { name: 'writer' })]),
    );
    const kitA = createEventKit(hasuraEvent)
      .use(loopPrevention, lpCfg)
      .use(observability, { sink: (b: ObservabilityBatch) => void aBatches.push(b) })
      .registerEvents([{ name: asEventName('e'), detector: detA, handler: handA } as EventModule]);
    await kitA.handle(hasuraInsert({ id: 'parent-row' })); // no inbound token → mints fresh

    const jobRowId = aBatches[0]!.jobs[0]!.id;
    // (a) persisted observability job row id === (b) the token's 3rd segment
    expect(codec.getJobExecutionId(outboundToken)).toBe(jobRowId);

    // ── Invocation B: a write stamped with A's outbound token triggers us ──
    const bBatches: ObservabilityBatch[] = [];
    const detB = hasuraEvent.detector(c => c.operation === 'INSERT');
    const handB = hasuraEvent.handler((event, _ctx) => run(event, []));
    const kitB = createEventKit(hasuraEvent)
      .use(loopPrevention, lpCfg)
      .use(observability, { sink: (b: ObservabilityBatch) => void bBatches.push(b) })
      .registerEvents([{ name: asEventName('e'), detector: detB, handler: handB } as EventModule]);
    await kitB.handle(hasuraInsert({ id: 'child-row', updated_by: outboundToken }));

    // (c) the child invocation's source_job_id links back to A's job row id
    expect(bBatches[0]!.invocation.source_job_id).toBe(jobRowId);
  });
});

describe('observability: safeSerialize strips non-serializable clients (sanitizeJobOptions parity)', () => {
  it('excludes SDK/Apollo/GraphQL clients, collapses circular refs, drops functions', () => {
    const sdkLike = { apollo: { cache: {} }, gql: { query() {}, mutation() {} } };
    const circular: Record<string, unknown> = { a: 1 };
    circular['self'] = circular;
    const out = safeSerialize({ sdk: sdkLike, circular, fn: () => 1, ok: 'value' }) as Record<string, unknown>;
    expect(out['sdk']).toBe('[sdk excluded]');
    expect((out['circular'] as Record<string, unknown>)['self']).toBe('[Circular]');
    expect(out['fn']).toBe('[Function]');
    expect(out['ok']).toBe('value');
  });
});

describe('observability: periodic mid-invocation flush feeds the live view', () => {
  it('upserts in-progress (running) snapshots before the terminal flush', async () => {
    const batches: ObservabilityBatch[] = [];
    const mod = defineFakeEvent('e', () => true, (event, _ctx) =>
      run(event, [job(() => new Promise(resolve => setTimeout(resolve, 60)), { name: 'slow' })]),
    );
    const kit = createEventKit(fakeSource())
      .use(observability, { sink: (b: ObservabilityBatch) => void batches.push(structuredClone(b)), flushIntervalMs: 10 })
      .registerEvents([mod]);
    await kit.handle('go');

    expect(batches.length).toBeGreaterThan(1); // periodic + final
    expect(batches.some(b => b.invocation.status === 'running')).toBe(true);
    expect(batches.some(b => b.jobs.some(j => j.status === 'running'))).toBe(true);
    expect(batches[batches.length - 1]!.invocation.status).toBe('completed'); // terminal
  });
});

describe('observability/graphql-sink', () => {
  it('bulk-upserts invocations → events → jobs in order via the injected transport', async () => {
    const calls: Array<{ query: string; objects: unknown[] }> = [];
    const sink = graphqlSink({
      endpoint: 'http://hasura/v1/graphql',
      headers: { 'x-hasura-admin-secret': 'secret' },
      request: async body => {
        calls.push({ query: body.query, objects: (body.variables as { objects: unknown[] }).objects });
        return {};
      },
    });
    const batches: ObservabilityBatch[] = [];
    const mod = defineFakeEvent('thing.happened', () => true, (event, _ctx) => run(event, [job(() => 'ok', { name: 'good' })]));
    const kit = createEventKit(fakeSource()).use(observability, { sink: (b: ObservabilityBatch) => { batches.push(b); return sink(b); } }).registerEvents([mod]);
    await kit.handle('go');

    // invocations first, then event_executions, then job_executions (FK order)
    expect(calls.map(c => c.query.match(/insert_(\w+)\(/)?.[1])).toEqual(['invocations', 'event_executions', 'job_executions']);
    expect((calls[0]!.objects[0] as { id: string }).id).toBe(batches[0]!.invocation.id);
    // omitted (undefined) columns are not sent
    expect(Object.values(calls[0]!.objects[0] as Record<string, unknown>).every(v => v !== undefined)).toBe(true);
  });

  it('retries on transport failure then succeeds', async () => {
    let attempts = 0;
    const sink = graphqlSink({
      endpoint: 'http://hasura/v1/graphql',
      retryDelayMs: 1,
      request: async () => {
        attempts += 1;
        if (attempts < 2) throw new Error('network blip');
        return {};
      },
    });
    await sink({
      invocation: {
        id: 'i1', correlation_id: 'c1', source_system: 'fake', status: 'completed',
        created_at: 'x', updated_at: 'x', events_detected_count: 0, total_jobs_run: 0,
        total_jobs_succeeded: 0, total_jobs_failed: 0,
      },
      events: [],
      jobs: [],
    });
    expect(attempts).toBe(2);
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
