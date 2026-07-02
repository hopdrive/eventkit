import { describe, it, expect } from 'vitest';
import { createEventKit, job, asEventName, assertSerializableMetadata, type EventModule, type JobContext } from '../../index.js';
import { fakeSource, defineFakeEvent } from '../../testing/index.js';
import { hasuraEvent } from '../source-hasura.js';
import { loopGuard, createTokenCodec } from '../loop-guard/index.js';
import { observability, type ObservabilityBatch } from '../observability/index.js';
import { graphqlSink } from '../observability/graphql-sink.js';
import { safeSerialize } from '../observability/serialize.js';
import { batch, type BatchJobUpdate, type DelayedBatchJobSpec } from '../batch/index.js';
import { grafana, type LokiPayload, type LoggerLike } from '../grafana/index.js';
import { sentry, type SentryEvent } from '../sentry/index.js';

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

describe('loopGuard', () => {
  const cfg = { field: 'updated_by', serviceId: 'svc-a', codec: { separator: '|', validateCorrelationId: true } };

  it('round-trips an inbound token: meta.sourceTrackingToken in, lineage-preserving ctx.trackingToken out', async () => {
    const inbound = `origin-svc|${UUID}|origin-job`;
    let metaToken: unknown;
    let outToken = '';
    let jobId = '';
    const mod = defineFakeEvent('e', () => true, [
      job((c: JobContext) => {
        metaToken = c.envelope.meta['sourceTrackingToken'];
        outToken = c.trackingToken;
        jobId = c.job.id;
      }),
    ]);
    // Use the Hasura source so the default reader finds new.updated_by.
    const kit = createEventKit(hasuraEvent).use(loopGuard, cfg).registerEvents([
      { name: asEventName('e'), detector: mod.detector, jobs: mod.jobs } as EventModule,
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
    const mod = defineFakeEvent('e', () => true, [
      job((c: JobContext) => {
        outToken = c.trackingToken;
        correlationId = c.correlationId;
      }),
    ]);
    const kit = createEventKit(hasuraEvent).use(loopGuard, cfg).registerEvents([
      { name: asEventName('e'), detector: mod.detector, jobs: mod.jobs } as EventModule,
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
    // The inbound token is on the envelope; a job reads it to decide suppression.
    const mod = defineFakeEvent('e', () => true, [
      job((c: JobContext) => {
        const inbound = c.envelope.meta['sourceTrackingToken'];
        suppressed = typeof inbound === 'string' && codec.getSource(inbound) === 'svc-a';
      }),
    ]);
    const kit = createEventKit(hasuraEvent).use(loopGuard, cfg).registerEvents([
      { name: asEventName('e'), detector: mod.detector, jobs: mod.jobs } as EventModule,
    ]);
    await kit.handle(hasuraInsert({ id: 1, updated_by: selfToken }));
    expect(suppressed).toBe(true);
  });

  // ── ADR-034: optional hop-depth ceiling ──────────────────────────────────
  describe('hop-depth ceiling (ADR-034)', () => {
    const codec = createTokenCodec({ separator: '|', validateCorrelationId: true });
    const depthCfg = (extra: Record<string, unknown>) => ({ ...cfg, ...extra });

    it('increments the hop counter across hops (and starts a fresh root at depth 1)', async () => {
      let rootOut = '';
      let chainedOut = '';
      const mod = (sink: (t: string) => void) =>
        ({ name: asEventName('e'), detector: hasuraEvent.detector(() => true), jobs: [job((c: JobContext) => void sink(c.trackingToken))] } as EventModule);

      // trackDepth on (warnAtDepth high so nothing fires) — a root gets depth 1.
      const rootKit = createEventKit(hasuraEvent).use(loopGuard, depthCfg({ warnAtDepth: 99 })).registerEvents([mod(t => (rootOut = t))]);
      await rootKit.handle(hasuraInsert({ id: 1 }));
      expect(codec.getHopDepth(rootOut)).toBe(1);

      // an inbound token already at depth 2 → this invocation is depth 3.
      const chainKit = createEventKit(hasuraEvent).use(loopGuard, depthCfg({ warnAtDepth: 99 })).registerEvents([mod(t => (chainedOut = t))]);
      await chainKit.handle(hasuraInsert({ id: 2, updated_by: `origin-svc|${UUID}|origin-job|2` }));
      expect(codec.getHopDepth(chainedOut)).toBe(3);
      expect(codec.getCorrelationId(chainedOut)).toBe(UUID); // chaining still holds
    });

    it('haltAtDepth suppresses dispatch: no detector/job runs, invocation returns cleanly', async () => {
      let ran = false;
      const mod = { name: asEventName('e'), detector: hasuraEvent.detector(() => { ran = true; return true; }), jobs: [job(() => { ran = true; })] } as EventModule;
      const kit = createEventKit(hasuraEvent).use(loopGuard, depthCfg({ haltAtDepth: 3 })).registerEvents([mod]);
      // inbound depth 2 → this invocation is depth 3 → at the ceiling → suppressed.
      const res = await kit.handle(hasuraInsert({ id: 1, updated_by: `origin-svc|${UUID}|origin-job|2` }));

      expect(ran).toBe(false);           // neither detector nor job ran
      expect(res.events).toHaveLength(0);
      expect(res.ok).toBe(true);         // clean stop, not an error
    });

    it('warnAtDepth logs a breadcrumb WITHOUT suppressing dispatch', async () => {
      const logs: Array<{ msg: string }> = [];
      const logcap = { name: 'logcap', onLog: (e: { message: string }) => void logs.push({ msg: e.message }) };
      let ran = false;
      const mod = { name: asEventName('e'), detector: hasuraEvent.detector(() => true), jobs: [job(() => { ran = true; })] } as EventModule;
      const kit = createEventKit(hasuraEvent).use(logcap).use(loopGuard, depthCfg({ warnAtDepth: 2 })).registerEvents([mod]);
      // inbound depth 1 → this invocation is depth 2 → warn (not halt).
      const res = await kit.handle(hasuraInsert({ id: 1, updated_by: `origin-svc|${UUID}|origin-job|1` }));

      expect(ran).toBe(true);            // dispatch proceeded
      expect(res.events).toHaveLength(1);
      expect(logs.some(l => /hop-depth warning/.test(l.msg))).toBe(true);
    });
  });
});

describe('observability', () => {
  it('flushes one batch per invocation with the canonical record field set', async () => {
    const batches: ObservabilityBatch[] = [];
    const mod = defineFakeEvent('thing.happened', () => true, [
      job(() => 'ok', { name: 'good', metadata: { tier: 1 } }),
      job(() => { throw new Error('x'); }, { name: 'bad' }),
    ]);
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
    const kit = createEventKit(hasuraEvent)
      .use(loopGuard, { field: 'updated_by', codec: { separator: '|', validateCorrelationId: true } })
      .use(observability, { sink: (bb: ObservabilityBatch) => void batches.push(bb) })
      .registerEvents([{ name: asEventName('batch.created'), detector, jobs: [] } as EventModule]);
    await kit.handle(hasuraInsert({ id: 1, updated_by: `prior-svc|${UUID}|prior-job-9` }));

    const inv = batches[0]!.invocation;
    expect(inv.source_system).toBe('hasura');
    expect(inv.source_table).toBe('public.batch_jobs');
    expect(inv.source_operation).toBe('INSERT');
    expect(inv.source_job_id).toBe('prior-job-9'); // loop-guard surfaced the prior job link
  });

  it('records a prepare crash on the invocation (onError) without failing execution', async () => {
    const batches: ObservabilityBatch[] = [];
    const mod = defineFakeEvent('e', () => true, [], { prepare: () => { throw new Error('handler boom'); } });
    const kit = createEventKit(fakeSource()).use(observability, { sink: (b: ObservabilityBatch) => void batches.push(b) }).registerEvents([mod]);
    const result = await kit.handle('x');
    expect(result.ok).toBe(true); // no-retry contract
    expect(batches[0]!.invocation.status).toBe('failed');
    expect(batches[0]!.invocation.error_message).toBe('handler boom');
  });

  it('clears a prior attempt error when a retried job finally succeeds', async () => {
    const batches: ObservabilityBatch[] = [];
    let attempts = 0;
    const mod = defineFakeEvent('e', () => true, [
      job(() => { attempts += 1; if (attempts < 3) throw new Error(`fail #${attempts}`); return 'ok'; }, { name: 'flaky', retries: 2 }),
    ]);
    const kit = createEventKit(fakeSource()).use(observability, { sink: (b: ObservabilityBatch) => void batches.push(b) }).registerEvents([mod]);
    await kit.handle('x');
    const jobRec = batches[0]!.jobs[0]!;
    expect(jobRec.status).toBe('completed');
    expect(jobRec.error_message).toBeUndefined(); // no stale error from attempts #1/#2
    expect(jobRec.result).toBe('ok');
  });

  it('records undetected events by default (Console parity) and can be turned off', async () => {
    const mod = defineFakeEvent('never', () => false, []);

    // default: undetected events ARE recorded (detected:false, not_detected)
    const onBatches: ObservabilityBatch[] = [];
    await createEventKit(fakeSource())
      .use(observability, { sink: (b: ObservabilityBatch) => void onBatches.push(b) })
      .registerEvents([mod])
      .handle('x');
    expect(onBatches[0]!.events).toHaveLength(1);
    expect(onBatches[0]!.events[0]).toMatchObject({ event_name: 'never', detected: false, status: 'not_detected' });
    expect(onBatches[0]!.invocation.events_detected_count).toBe(0);

    // recordUndetectedEvents:false → only fired/errored events recorded
    const offBatches: ObservabilityBatch[] = [];
    await createEventKit(fakeSource())
      .use(observability, { sink: (b: ObservabilityBatch) => void offBatches.push(b), recordUndetectedEvents: false })
      .registerEvents([mod])
      .handle('x');
    expect(offBatches[0]!.events).toHaveLength(0);
  });

  it('source_function prefers the source identity (Hasura trigger name) over the platform function name', async () => {
    const batches: ObservabilityBatch[] = [];
    const detector = hasuraEvent.detector(() => false);
    const kit = createEventKit(hasuraEvent)
      .use(observability, { sink: (b: ObservabilityBatch) => void batches.push(b) })
      .registerEvents([{ name: asEventName('e'), detector, jobs: [] } as EventModule]);
    // hasuraInsert sets trigger.name = 'db-appointments-test'
    await kit.handle({ id: 'e', created_at: '2026-06-28T12:00:00Z', table: { schema: 'public', name: 't' }, trigger: { name: 'db-appointments-test' }, event: { op: 'INSERT', data: { old: null, new: { id: 1 } }, session_variables: {} } });
    expect(batches[0]!.invocation.source_function).toBe('db-appointments-test');
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
    const kitA = createEventKit(hasuraEvent)
      .use(loopGuard, lpCfg)
      .use(observability, { sink: (b: ObservabilityBatch) => void aBatches.push(b) })
      .registerEvents([
        { name: asEventName('e'), detector: detA, jobs: [job((c: JobContext) => void (outboundToken = c.trackingToken), { name: 'writer' })] } as EventModule,
      ]);
    await kitA.handle(hasuraInsert({ id: 'parent-row' })); // no inbound token → mints fresh

    const jobRowId = aBatches[0]!.jobs[0]!.id;
    // (a) persisted observability job row id === (b) the token's 3rd segment
    expect(codec.getJobExecutionId(outboundToken)).toBe(jobRowId);

    // ── Invocation B: a write stamped with A's outbound token triggers us ──
    const bBatches: ObservabilityBatch[] = [];
    const detB = hasuraEvent.detector(c => c.operation === 'INSERT');
    const kitB = createEventKit(hasuraEvent)
      .use(loopGuard, lpCfg)
      .use(observability, { sink: (b: ObservabilityBatch) => void bBatches.push(b) })
      .registerEvents([{ name: asEventName('e'), detector: detB, jobs: [] } as EventModule]);
    await kitB.handle(hasuraInsert({ id: 'child-row', updated_by: outboundToken }));

    // (c) the child invocation's source_job_id links back to A's job row id
    expect(bBatches[0]!.invocation.source_job_id).toBe(jobRowId);
    // (d) correlation chaining: the child runs under the SAME correlationId as the parent
    expect(bBatches[0]!.invocation.correlation_id).toBe(aBatches[0]!.invocation.correlation_id);
  });
});

describe('loop-guard: multi-strategy extraction (chains via metadata/session, not just updated_by)', () => {
  const cfg = { codec: { separator: '|', validateCorrelationId: true } };
  const captureCorrelation = (raw: unknown) => {
    let cid = '';
    // a job reads the resolved correlationId off its context (set by loop-guard)
    const mod = defineFakeEvent('e', () => true, [job((c: JobContext) => { cid = c.correlationId; })]);
    const kit = createEventKit(hasuraEvent).use(loopGuard, cfg).registerEvents([
      { name: asEventName('e'), detector: mod.detector, jobs: mod.jobs } as EventModule,
    ]);
    return kit.handle(raw).then(() => cid);
  };

  it('extracts a correlation id from a metadata column', async () => {
    const cid = await captureCorrelation(hasuraInsert({ id: 1, correlation_id: UUID }));
    expect(cid).toBe(UUID);
  });

  it('extracts a correlation id from a session variable', async () => {
    const payload = {
      id: 'e', created_at: '2026-06-28T12:00:00Z', table: { schema: 'public', name: 't' }, trigger: { name: 't' },
      event: { op: 'INSERT', data: { old: null, new: { id: 1 } }, session_variables: { 'x-correlation-id': UUID } },
    };
    const cid = await captureCorrelation(payload);
    expect(cid).toBe(UUID);
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
    const mod = defineFakeEvent('e', () => true, [job(() => new Promise(resolve => setTimeout(resolve, 60)), { name: 'slow' })]);
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
    const mod = defineFakeEvent('thing.happened', () => true, [job(() => 'ok', { name: 'good' })]);
    const kit = createEventKit(fakeSource()).use(observability, { sink: (b: ObservabilityBatch) => { batches.push(b); return sink(b); } }).registerEvents([mod]);
    await kit.handle('go');

    // invocations first, then event_executions, then job_executions (FK order)
    expect(calls.map(c => c.query.match(/insert_(\w+)\(/)?.[1])).toEqual(['invocations', 'event_executions', 'job_executions']);
    expect((calls[0]!.objects[0] as { id: string }).id).toBe(batches[0]!.invocation.id);
    // omitted (undefined) columns are not sent
    expect(Object.values(calls[0]!.objects[0] as Record<string, unknown>).every(v => v !== undefined)).toBe(true);
  });

  const invocationRecord = (extra: Record<string, unknown> = {}) => ({
    invocation: {
      id: 'i1', correlation_id: 'c1', source_system: 'hasura', source_function: 'db-x',
      source_event_payload: {}, status: 'completed', created_at: 'x', updated_at: 'x',
      events_detected_count: 0, total_jobs_run: 0, total_jobs_succeeded: 0, total_jobs_failed: 0,
      ...extra,
    },
    events: [],
    jobs: [],
  });

  it('graceful-degrades a source_job_id FK violation: retries the invocation without the link', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let firstCall = true;
    const sink = graphqlSink({
      endpoint: 'http://h/v1/graphql',
      request: async body => {
        const obj = (body.variables as { objects: Record<string, unknown>[] }).objects[0]!;
        if (/insert_invocations/.test(body.query)) {
          sent.push(obj);
          if (firstCall) {
            firstCall = false;
            // Simulate Hasura's FK violation on source_job_id (a GraphQL-level error).
            return { errors: [{ message: 'Foreign key violation. ... constraint "fk_invocations_source_job_id"' }] } as never;
          }
        }
        return {};
      },
    });
    // The invocation carries an unverifiable prior-job link.
    await sink(invocationRecord({ source_job_id: 'b194b7c0-49a5-4d02-b752-45008b472916' }) as never);

    expect(sent).toHaveLength(2); // first attempt (with link) + degraded retry (without)
    expect(sent[0]).toHaveProperty('source_job_id');
    expect(sent[1]).not.toHaveProperty('source_job_id'); // link dropped, record preserved
  });

  it('does NOT retry a non-FK GraphQL error (deterministic — surfaces immediately)', async () => {
    let calls = 0;
    const sink = graphqlSink({
      endpoint: 'http://h/v1/graphql',
      maxRetries: 3,
      request: async () => {
        calls += 1;
        return { errors: [{ message: 'field "bogus" not found' }] } as never;
      },
    });
    await expect(sink(invocationRecord() as never)).rejects.toThrow(/GraphQL errors/);
    expect(calls).toBe(1); // no wasteful retries on a deterministic GraphQL error
  });

  it('maps eventkit statuses to the legacy CHECK-constraint set (default) and can be disabled', async () => {
    const captured: Array<{ table: string; status: string }> = [];
    const capture = (mapStatuses?: boolean) =>
      graphqlSink({
        endpoint: 'http://h/v1/graphql',
        ...(mapStatuses === false ? { mapStatuses: false } : {}),
        request: async body => {
          const table = body.query.match(/insert_(\w+)\(/)?.[1] ?? '';
          for (const o of (body.variables as { objects: Array<{ status?: string }> }).objects) {
            if (o.status) captured.push({ table, status: o.status });
          }
          return {};
        },
      });
    const batch = {
      invocation: { ...invocationRecord().invocation, status: 'timeout' },
      events: [{ id: 'e', invocation_id: 'i1', correlation_id: 'c1', event_name: 'x', detected: true, jobs_count: 1, jobs_succeeded: 0, jobs_failed: 1, status: 'detected', created_at: 'x', updated_at: 'x' }],
      jobs: [{ id: 'j', invocation_id: 'i1', correlation_id: 'c1', job_name: 'x', status: 'timed_out', created_at: 'x', updated_at: 'x' }],
    };
    await capture()(batch as never);
    expect(captured).toEqual([
      { table: 'invocations', status: 'failed' }, // timeout → failed
      { table: 'event_executions', status: 'handling' }, // detected → handling
      { table: 'job_executions', status: 'failed' }, // timed_out → failed
    ]);

    captured.length = 0;
    await capture(false)(batch as never); // mapStatuses:false → passthrough (for a migrated schema)
    expect(captured.map(c => c.status)).toEqual(['timeout', 'detected', 'timed_out']);
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

describe('batch', () => {
  const buildKit = (store: { update: (id: string | number, f: BatchJobUpdate) => void }) => {
    const detector = hasuraEvent.detector(ctx => ctx.operation === 'INSERT');
    return createEventKit(hasuraEvent)
      .use(batch, { store })
      .registerEvents([{ name: asEventName('batch.created'), detector, jobs: [job(capture, { name: 'proc' })] } as EventModule]);
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
    // result/logs/error are FOLDED INTO output (the real batch_jobs has only status+output)
    expect(done!.fields.output).toEqual({ result: { processed: true } });
    // never writes columns that don't exist on batch_jobs
    expect(updates.every(u => Object.keys(u.fields).every(k => k === 'status' || k === 'output'))).toBe(true);
  });

  it('schedules a durable delayed retry on failure when durableRetry is configured', async () => {
    const updates: Array<{ id: string | number; fields: BatchJobUpdate }> = [];
    const delayed: DelayedBatchJobSpec[] = [];
    const detector = hasuraEvent.detector(ctx => ctx.operation === 'INSERT');
    const kit = createEventKit(hasuraEvent)
      .use(batch, {
        store: {
          update: (id, fields) => void updates.push({ id, fields }),
          enqueueDelayed: (spec: DelayedBatchJobSpec) => void delayed.push(spec),
        },
        durableRetry: { delayMs: 5000, maxAttempts: 3 },
      })
      .registerEvents([
        { name: asEventName('batch.created'), detector, jobs: [job(() => { throw new Error('transient'); }, { name: 'proc' })] } as EventModule,
      ]);
    await kit.handle(hasuraInsert({ id: 'row-7', input: { workUnit: 'W' }, trigger_type: 'ap', delay_key: 'ap-7' }));

    expect(delayed).toHaveLength(1); // a crash-surviving retry row was scheduled
    expect(delayed[0]!.triggerType).toBe('ap');
    expect(delayed[0]!.uniqueKey).toBe('ap-7'); // dedup via delay_key
    expect(delayed[0]!.delayMs).toBe(5000);
    expect((delayed[0]!.input as Record<string, unknown>)['__retryAttempt']).toBe(1);
    // P0-4 / §12.4: a row with a LIVE retry reads as a non-terminal retry state, NOT
    // terminal 'error' — an operator must be able to tell "retrying" from "dead."
    const lastStatus = updates.filter(u => u.fields.status).at(-1)!.fields.status;
    expect(lastStatus).toBe('delaying');
    expect(updates.find(u => u.fields.status === 'error')).toBeFalsy();
  });

  it("terminates as 'error' once durable retries are exhausted (no follow-up scheduled)", async () => {
    const updates: Array<{ id: string | number; fields: BatchJobUpdate }> = [];
    const delayed: DelayedBatchJobSpec[] = [];
    const detector = hasuraEvent.detector(ctx => ctx.operation === 'INSERT');
    const kit = createEventKit(hasuraEvent)
      .use(batch, {
        store: {
          update: (id, fields) => void updates.push({ id, fields }),
          enqueueDelayed: (spec: DelayedBatchJobSpec) => void delayed.push(spec),
        },
        durableRetry: { delayMs: 5000, maxAttempts: 3 },
      })
      .registerEvents([
        { name: asEventName('batch.created'), detector, jobs: [job(() => { throw new Error('transient'); }, { name: 'proc' })] } as EventModule,
      ]);
    // The row's input already carries __retryAttempt at the ceiling → no further retry.
    await kit.handle(hasuraInsert({ id: 'row-9', input: { workUnit: 'W', __retryAttempt: 3 }, trigger_type: 'ap', delay_key: 'ap-9' }));

    expect(delayed).toHaveLength(0); // exhausted — nothing scheduled
    const lastStatus = updates.filter(u => u.fields.status).at(-1)!.fields.status;
    expect(lastStatus).toBe('error'); // terminal, correctly
  });

  it('handler input overrides the row baseline (handler keys win)', async () => {
    captured = undefined;
    const detector = hasuraEvent.detector(ctx => ctx.operation === 'INSERT');
    const kit = createEventKit(hasuraEvent)
      .use(batch, { store: { update: () => {} } })
      .registerEvents([
        { name: asEventName('batch.created'), detector, jobs: [job(capture, { name: 'proc', input: { workUnit: 'override' } })] } as EventModule,
      ]);
    await kit.handle(hasuraInsert({ id: 'row-2', input: { workUnit: 'W' } }));
    expect(captured).toEqual({ workUnit: 'override' });
  });

  it('throws at validate() when the Hasura source is absent (requires: source:hasura)', () => {
    const detector = fakeSource().detector(() => true);
    const kit = createEventKit(fakeSource())
      .use(batch, { store: { update: () => {} } })
      .registerEvents([{ name: asEventName('e'), detector, jobs: [] } as unknown as EventModule]);
    expect(() => kit.validate()).toThrow(/source:hasura/);
  });

  // ── D13: metadata serializability fail-fast + client-stripping ─────────────
  it('assertSerializableMetadata throws NAMING the offending key (live client, function)', () => {
    const sdkLike = { apollo: { cache: {} } };
    expect(() => assertSerializableMetadata({ ok: 1, deps: { sdk: sdkLike } }, 'meta'))
      .toThrow(/meta\.deps\.sdk.*live sdk/);
    expect(() => assertSerializableMetadata({ handler: () => 1 }, 'meta'))
      .toThrow(/meta\.handler.*function/);
    expect(() => assertSerializableMetadata({ ok: 1, nested: { fine: 'yes' } })).not.toThrow();
  });

  it('non-serializable job metadata + Batch registered → fails loud via onError, naming the key', async () => {
    const errors: string[] = [];
    const errspy = { name: 'errspy', onError: (c: { error: { message: string } }) => void errors.push(c.error.message) };
    const detector = hasuraEvent.detector(ctx => ctx.operation === 'INSERT');
    const kit = createEventKit(hasuraEvent)
      .use(errspy)
      .use(batch, { store: { update: () => {} } })
      .registerEvents([
        // a live sdk-like client wrongly placed in the serializable metadata channel
        { name: asEventName('batch.created'), detector, jobs: [job(() => 'ok', { name: 'proc', metadata: { client: { apollo: {} } } })] } as EventModule,
      ]);
    await kit.handle(hasuraInsert({ id: 'row-x', input: {} }));

    expect(errors.some(m => /metadata.*client.*live sdk/i.test(m))).toBe(true);
  });

  it('a live client in a job result is stripped from the persisted batch output, not corrupting the write', async () => {
    const updates: Array<{ id: string | number; fields: BatchJobUpdate }> = [];
    const detector = hasuraEvent.detector(ctx => ctx.operation === 'INSERT');
    const sdkLike = { apollo: { cache: {} } };
    const kit = createEventKit(hasuraEvent)
      .use(batch, { store: { update: (id, fields) => void updates.push({ id, fields }) } })
      .registerEvents([
        { name: asEventName('batch.created'), detector, jobs: [job(() => ({ sdk: sdkLike, ok: 'value' }), { name: 'proc' })] } as EventModule,
      ]);
    await kit.handle(hasuraInsert({ id: 'row-z', input: {} }));

    const done = updates.find(u => u.fields.status === 'done')!;
    expect((done.fields.output as { result: Record<string, unknown> }).result).toEqual({ sdk: '[sdk excluded]', ok: 'value' });
  });
});

describe('transports/grafana (direct Loki mode)', () => {
  it('buffers job logs (with jobExecutionId) and flushes a Loki payload; correlation fields stay out of stream labels', async () => {
    const payloads: LokiPayload[] = [];
    let jobId = '';
    const mod = defineFakeEvent('e', () => true, [
      job((c: JobContext) => { jobId = c.job.id; c.log.info('hello from job', { n: 1 }); }, { name: 'j' }),
    ]);
    const kit = createEventKit(fakeSource())
      .use(grafana, { grafana: { endpoint: 'http://loki', labels: { app: 'test' }, send: (p: LokiPayload) => void payloads.push(p) } })
      .registerEvents([mod]);
    await kit.handle('go');

    expect(payloads).toHaveLength(1);
    const stream = payloads[0]!.streams[0]!;
    expect(stream.stream).toMatchObject({ app: 'test' });
    // high-cardinality fields must NOT be stream labels (Loki index cardinality)
    expect(Object.keys(stream.stream)).not.toContain('jobExecutionId');
    expect(Object.keys(stream.stream)).not.toContain('correlationId');
    const jobLine = stream.values.map(([, line]) => JSON.parse(line)).find(l => l.message === 'hello from job');
    expect(jobLine).toBeTruthy();
    expect(jobLine.jobExecutionId).toBe(jobId); // per-job-execution queryability
    expect(jobLine.jobName).toBe('j');
  });
});

describe('transports/grafana (injected-logger bridge mode)', () => {
  it('forwards entries to an injected sdk-server-logger-shaped logger; never touches Loki', async () => {
    const calls: Array<{ level: string; message: string; error?: unknown; metadata?: Record<string, unknown> }> = [];
    const logger: LoggerLike = {
      info: (message, metadata) => void calls.push({ level: 'info', message, metadata }),
      warn: (message, metadata) => void calls.push({ level: 'warn', message, metadata }),
      error: (message, error, metadata) => void calls.push({ level: 'error', message, error, metadata }),
    };
    let jobId = '';
    const mod = defineFakeEvent('e', () => true, [
      job((c: JobContext) => { jobId = c.job.id; c.log.info('hello from job', { n: 1 }); }, { name: 'j' }),
    ]);
    const kit = createEventKit(fakeSource())
      .use(grafana, { logger, source: 'eventkit' })
      .registerEvents([mod]);
    await kit.handle('go');

    const jobLine = calls.find(c => c.message === 'hello from job');
    expect(jobLine).toBeTruthy();
    expect(jobLine!.level).toBe('info');
    // like-for-like field schema: logType + scopeId (= jobExecutionId) so the legacy
    // console `| json | scopeId=…` / `logType=…` queries match unchanged.
    expect(jobLine!.metadata).toMatchObject({
      source: 'eventkit',
      logType: 'job',
      jobName: 'j',
      jobExecutionId: jobId,
      scopeId: jobId,
      data: { n: 1 },
    });
  });

  it('routes errors through logger.error(message, error, metadata) with the SerializedError', async () => {
    const errors: Array<{ message: string; error: unknown; metadata?: Record<string, unknown> }> = [];
    const logger: LoggerLike = {
      info: () => {},
      warn: () => {},
      error: (message, error, metadata) => void errors.push({ message, error, metadata }),
    };
    const mod = defineFakeEvent('e', () => true, [], { prepare: () => { throw new Error('kaboom'); } });
    const kit = createEventKit(fakeSource())
      .use(grafana, { logger })
      .registerEvents([mod]);
    await kit.handle('go');

    expect(errors.length).toBeGreaterThan(0);
    const handleErr = errors.find(e => e.message.includes('kaboom'));
    expect(handleErr).toBeTruthy();
    expect(handleErr!.message).toMatch(/^\[handle\] Error: kaboom/);
    expect((handleErr!.error as { message?: string }).message).toBe('kaboom');
  });

  it('invokes the injected flush seam at end of invocation (mode 1 does not own flush by default)', async () => {
    let flushed = 0;
    const logger: LoggerLike = { info: () => {}, warn: () => {}, error: () => {} };
    const mod = defineFakeEvent('e', () => true, []);
    const kit = createEventKit(fakeSource())
      .use(grafana, { logger, flush: () => { flushed += 1; } })
      .registerEvents([mod]);
    await kit.handle('go');
    expect(flushed).toBe(1);
  });

  it('throws when neither logger nor grafana config is provided', () => {
    expect(() => grafana({})).toThrow(/requires either `logger`/);
  });

  it('forwards the concise lifecycle narrative (detection / running / per-job / completed)', async () => {
    const lines: Array<{ msg: string; scope?: string; jobName?: string }> = [];
    const logger: LoggerLike = {
      info: (message, metadata) => void lines.push({ msg: message, scope: metadata?.scope, jobName: metadata?.jobName }),
      warn: () => {},
      error: () => {},
    };
    const mod = defineFakeEvent('e', () => true, [
      job(() => 'ok', { name: 'good' }),
      job(() => { throw new Error('nope'); }, { name: 'bad' }),
    ]);
    const kit = createEventKit(fakeSource())
      .use(grafana, { logger })
      .registerEvents([mod]);
    await kit.handle('go');

    const msgs = lines.map(l => l.msg);
    expect(msgs).toContain('e ⭐ detected');
    expect(msgs).toContain('e running 2 jobs');
    expect(lines.find(l => l.msg.startsWith('✓ good'))?.msg).toMatch(/^✓ good \d+ms$/);
    expect(lines.find(l => l.msg.startsWith('✗ bad'))?.msg).toMatch(/^✗ bad \d+ms \(Error\)$/);
    expect(msgs).toContain('e completed 2 jobs (1 failed)');
    // scopes are structured fields, not baked into the message
    expect(lines.find(l => l.msg === 'e ⭐ detected')?.scope).toBe('detection');
    expect(lines.find(l => l.msg.startsWith('✓ good'))?.scope).toBe('job');
  });

  it('maps scope → logType (detector/handler/job) for the legacy console contract', async () => {
    const lines: Array<{ msg: string; logType?: string; scopeId?: string }> = [];
    const logger: LoggerLike = {
      info: (message, m) => void lines.push({ msg: message, logType: m?.logType as string, scopeId: m?.scopeId as string }),
      warn: () => {},
      error: () => {},
    };
    let jobId = '';
    let invId = '';
    const mod = defineFakeEvent('e', () => true, [
      job((c: JobContext) => { jobId = c.job.id; invId = c.invocationId; c.log.info('inside'); }, { name: 'j' }),
    ]);
    await createEventKit(fakeSource()).use(grafana, { logger }).registerEvents([mod]).handle('go');

    expect(lines.find(l => l.msg === 'e ⭐ detected')?.logType).toBe('detector');
    expect(lines.find(l => l.msg === 'e running 1 job')?.logType).toBe('handler');
    expect(lines.find(l => l.msg === 'inside')?.logType).toBe('job');
    // scopeId: jobExecutionId for job logs, invocationId for framework lines
    expect(lines.find(l => l.msg === 'inside')?.scopeId).toBe(jobId);
    expect(lines.find(l => l.msg === 'e ⭐ detected')?.scopeId).toBe(invId);
  });
});

describe('transports/sentry', () => {
  it('forwards a handler crash as a Sentry event with tags intact', async () => {
    const events: SentryEvent[] = [];
    const mod = defineFakeEvent('e', () => true, [], { prepare: () => { throw new Error('kaboom'); } });
    const kit = createEventKit(fakeSource())
      .use(sentry, { dsn: 'https://pub@o1.ingest.sentry.io/42', send: (e: SentryEvent) => void events.push(e) })
      .registerEvents([mod]);
    await kit.handle('go');

    expect(events).toHaveLength(1);
    expect(events[0]!.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(events[0]!.exception.values[0]).toMatchObject({ type: 'Error', value: 'kaboom' });
    expect(events[0]!.tags.phase).toBe('handle');
    expect(events[0]!.level).toBe('error');
  });

  it('the default sender posts a real Sentry envelope to the DSN-derived endpoint', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as typeof fetch;
    try {
      const mod = defineFakeEvent('e', () => true, [], { prepare: () => { throw new Error('boom'); } });
      const kit = createEventKit(fakeSource())
        .use(sentry, { dsn: 'https://pub@o1.ingest.sentry.io/42', environment: 'test' })
        .registerEvents([mod]);
      await kit.handle('go');
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://o1.ingest.sentry.io/api/42/envelope/');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-sentry-auth']).toContain('sentry_key=pub');
    expect(headers['content-type']).toBe('application/x-sentry-envelope');
    // envelope = 3 newline-delimited JSON lines: header, item header, event
    const lines = String(calls[0]!.init.body).split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2]!).exception.values[0].value).toBe('boom');
  });

  it('throws when neither a dsn nor a custom send is provided', () => {
    expect(() => sentry({})).toThrow(/requires a `dsn`/);
  });
});
