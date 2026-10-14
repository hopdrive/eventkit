// ADR-045 — end-of-invocation work runs after the response where the platform allows it.
//
// The behaviours pinned here, end to end through the real runtime:
//   - handle() hands onInvocationEnd + onFlush to RequestContext.waitUntil and returns first;
//     without waitUntil it awaits them, as before.
//   - netlifyV2Platform turns Netlify's context.waitUntil into RequestContext.waitUntil.
//   - observability's job-start write runs alongside the job body by default ('background'),
//     its writes for one invocation never land out of order, and onFlush never finalizes an
//     invocation that is still running.
//   - graphqlSink sends the three upserts as one request, and retries a missing parent-job
//     link before dropping it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ClientError, asEventName, createEventKit, job, type EventKitPlugin, type EventModule } from '../../index.js';
import { fakeSource, defineFakeEvent } from '../../testing/index.js';
import { hasuraEvent } from '../../plugins/source-hasura.js';
import { lambdaPlatform, netlifyBackgroundPlatform, netlifyPlatform, netlifyV2BackgroundPlatform, netlifyV2Platform } from '../../plugins/platforms.js';
import { observability, type ObservabilityBatch } from '../../plugins/observability/index.js';
import { graphqlSink } from '../../plugins/observability/graphql-sink.js';
import { batch, type BatchJobUpdate } from '../../plugins/batch/index.js';

/** A promise the test opens by hand. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>(resolve => (open = resolve));
  return { wait, open };
}

/** A waitUntil that collects what it is handed, so the test can settle it. */
function collector() {
  const promises: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => void promises.push(p), promises, settle: () => Promise.all(promises) };
}

/** A minimal platform whose buildRequest forwards a waitUntil from the second handler argument. */
const passthroughPlatform: EventKitPlugin = {
  name: 'platform-test',
  provides: ['platform'],
  extractPayload: (raw: unknown) => raw,
  buildRequest: (_raw: unknown, ctx?: unknown) => {
    const w = (ctx as { waitUntil?: (p: Promise<unknown>) => void } | undefined)?.waitUntil;
    return w ? { waitUntil: w } : {};
  },
  formatResponse: (result: unknown) => result,
  formatRejection: (r: unknown) => r,
};

const okEvent = () => defineFakeEvent('thing.happened', () => true, [job(() => 'ok', { name: 'good' })]);

describe('runtime: end-of-invocation work and RequestContext.waitUntil', () => {
  it('hands onInvocationEnd + onFlush to waitUntil and returns before they finish', async () => {
    const g = gate();
    const seen: string[] = [];
    const slowEnd: EventKitPlugin = {
      name: 'slow-end',
      async onInvocationEnd() {
        await g.wait;
        seen.push('end');
      },
      onFlush() {
        seen.push('flush');
      },
    };
    const kit = createEventKit(fakeSource()).use(slowEnd).registerEvents([okEvent()]);
    const w = collector();

    const result = await kit.handle('go', { waitUntil: w.waitUntil });

    expect(result.ok).toBe(true);
    expect(seen).toEqual([]); // still running — handle() did not wait for it
    expect(w.promises).toHaveLength(1);
    g.open();
    await w.settle();
    expect(seen).toEqual(['end', 'flush']);
  });

  it('awaits the same work before returning when the request has no waitUntil', async () => {
    const seen: string[] = [];
    const end: EventKitPlugin = {
      name: 'end',
      async onInvocationEnd() {
        await new Promise(resolve => setTimeout(resolve, 5));
        seen.push('end');
      },
      onFlush() {
        seen.push('flush');
      },
    };
    const kit = createEventKit(fakeSource()).use(end).registerEvents([okEvent()]);

    await kit.handle('go');

    expect(seen).toEqual(['end', 'flush']);
  });

  it('defers the flush of a request the source rejects before dispatch', async () => {
    const g = gate();
    let flushed = false;
    const rejecting = { ...fakeSource(), normalize: () => { throw new ClientError(401, 'bad signature'); } };
    const kit = createEventKit(rejecting)
      .use({ name: 'slow-flush', async onFlush() { await g.wait; flushed = true; } })
      .registerEvents([okEvent()]);
    const w = collector();

    const result = await kit.handle('go', { waitUntil: w.waitUntil });

    expect(result.resolved?.error?.status).toBe(401);
    expect(flushed).toBe(false);
    g.open();
    await w.settle();
    expect(flushed).toBe(true);
  });

  it('deferred plugins see the run as it settled, not the reply handler() attaches afterwards', async () => {
    const g = gate();
    let seenResolved: unknown = 'not called';
    const kit = createEventKit(fakeSource())
      .use(passthroughPlatform)
      .use({
        name: 'reads-result',
        async onInvocationEnd(_ctx, result) {
          await g.wait;
          seenResolved = result.resolved;
        },
      })
      .registerEvents([okEvent()]);
    const w = collector();

    const reply = (await kit.handler({ after: { body: { quoted: true } } })('go', { waitUntil: w.waitUntil })) as {
      resolved?: { output?: unknown };
    };

    expect(reply.resolved?.output).toEqual({ quoted: true });
    g.open();
    await w.settle();
    expect(seenResolved).toBeUndefined();
  });
});

describe('netlifyV2Platform: context.waitUntil', () => {
  afterEach(() => vi.restoreAllMocks());

  const apptReady = (): EventModule => {
    const detector = hasuraEvent.detector(ctx => ctx.operation === 'INSERT');
    return { name: asEventName('appointment.ready'), detector, jobs: [job(() => ({ sent: true }), { name: 'notify' })] } as EventModule;
  };
  const request = () =>
    new Request('https://fn.example/db-appointments', {
      method: 'POST',
      body: JSON.stringify({
        id: 'evt',
        created_at: '2026-06-28T12:00:00.000Z',
        table: { schema: 'public', name: 'appointments' },
        trigger: { name: 't' },
        event: { op: 'INSERT', data: { old: null, new: { id: 1 } }, session_variables: {} },
      }),
    });
  /** observability with a sink that records each batch and blocks on `g` until opened. */
  const gatedObservability = (g: { wait: Promise<void> }, batches: ObservabilityBatch[]) =>
    observability({
      sink: async (b: ObservabilityBatch) => {
        await g.wait;
        batches.push(structuredClone(b));
      },
    });

  it('replies while the observability sink is blocked, then writes under waitUntil', async () => {
    const g = gate();
    const batches: ObservabilityBatch[] = [];
    const kit = createEventKit(hasuraEvent).use(netlifyV2Platform).use(gatedObservability(g, batches)).registerEvents([apptReady()]);
    const w = collector();

    const res = (await kit.handler()(request(), { waitUntil: w.waitUntil })) as Response;

    expect(res.status).toBe(200);
    expect(batches).toHaveLength(0);
    g.open();
    await w.settle();
    const final = batches[batches.length - 1]!;
    expect(final.invocation.status).toBe('completed');
    expect(final.jobs.map(j => j.status)).toEqual(['completed']);
  });

  it("afterResponse: 'await' keeps the writes before the reply and ignores context.waitUntil", async () => {
    const batches: ObservabilityBatch[] = [];
    const kit = createEventKit(hasuraEvent)
      .use(netlifyV2Platform, { afterResponse: 'await' })
      .use(observability, { sink: (b: ObservabilityBatch) => void batches.push(b) })
      .registerEvents([apptReady()]);
    const w = collector();

    await kit.handler()(request(), { waitUntil: w.waitUntil });

    expect(w.promises).toHaveLength(0);
    expect(batches.length).toBeGreaterThan(0);
  });

  it('falls back to awaiting, and warns once, when the context has no waitUntil', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const batches: ObservabilityBatch[] = [];
    const kit = createEventKit(hasuraEvent)
      .use(netlifyV2Platform)
      .use(observability, { sink: (b: ObservabilityBatch) => void batches.push(b) })
      .registerEvents([apptReady()]);
    const handler = kit.handler();

    await handler(request(), {});
    await handler(request());

    expect(batches.length).toBeGreaterThan(0); // written before the reply
    const ours = warn.mock.calls.filter(c => /platform-netlify-v2: the request's context has no waitUntil/.test(String(c[0])));
    expect(ours).toHaveLength(1);
  });

  it('platforms that cannot run work after returning never set waitUntil', () => {
    const ctx = { waitUntil: () => undefined, getRemainingTimeInMillis: () => 1000 };
    for (const p of [lambdaPlatform(), netlifyPlatform(), netlifyBackgroundPlatform(), netlifyV2BackgroundPlatform()]) {
      expect(p.buildRequest({ body: '{}' }, ctx).waitUntil).toBeUndefined();
    }
  });
});

describe('observability: persistJobsAtStart', () => {
  const run = async (persistJobsAtStart: boolean | 'auto' | 'await' | 'background' | undefined, deferred = false) => {
    const g = gate();
    const order: string[] = [];
    const batches: ObservabilityBatch[] = [];
    let first = true;
    const kit = createEventKit(fakeSource())
      .use(observability, {
        ...(persistJobsAtStart === undefined ? {} : { persistJobsAtStart }),
        sink: async (b: ObservabilityBatch) => {
          const snapshot = structuredClone(b);
          if (first) {
            first = false;
            await g.wait; // hold the first write (the job-start one) open
          }
          batches.push(snapshot);
          order.push(`write:${snapshot.jobs.map(j => j.status).join(',') || 'none'}`);
        },
      })
      .registerEvents([
        defineFakeEvent('e', () => true, [
          job(() => { order.push('job'); return 'ok'; }, { name: 'good' }),
        ]),
      ]);
    // Opening the gate shortly after lets an awaiting mode proceed; 'background' must not need it.
    setTimeout(g.open, 20);
    const w = collector();
    await kit.handle('go', deferred ? { waitUntil: w.waitUntil } : {});
    await w.settle();
    return { order, batches };
  };

  it("the default ('auto') runs the body alongside the start write when the request has waitUntil", async () => {
    const { order, batches } = await run(undefined, true);
    expect(order[0]).toBe('job'); // the body did not wait for the write
    // Writes land in order: the start snapshot (running) before the terminal one.
    expect(order.slice(1)).toEqual(['write:running', 'write:completed']);
    expect(batches[0]!.jobs[0]!.id).toBe(batches[1]!.jobs[0]!.id); // the same row, upserted
  });

  it("the default ('auto') keeps the pre-0.8.0 order when nothing is deferred (Lambda, classic Netlify)", async () => {
    const { order } = await run(undefined, false);
    expect(order).toEqual(['write:running', 'job', 'write:completed']);
  });

  it("'background' runs the body alongside the start write even when nothing is deferred", async () => {
    const { order } = await run('background', false);
    expect(order).toEqual(['job', 'write:running', 'write:completed']);
  });

  it("'await' and true make the row durable before the job body runs, deferred or not", async () => {
    for (const mode of ['await', true] as const) {
      for (const deferred of [false, true]) {
        const { order } = await run(mode, deferred);
        expect(order).toEqual(['write:running', 'job', 'write:completed']);
      }
    }
  });

  it('false writes only the terminal batch', async () => {
    const { order } = await run(false);
    expect(order).toEqual(['job', 'write:completed']);
  });

  it('parallel jobs share their job-start write instead of queuing one each', async () => {
    let writes = 0;
    const kit = createEventKit(fakeSource())
      .use(observability, {
        sink: async () => {
          writes += 1;
          await new Promise(resolve => setTimeout(resolve, 50));
        },
      })
      .registerEvents([
        defineFakeEvent('e', () => true, Array.from({ length: 20 }, (_, i) => job(() => i, { name: `j${i}` }))),
      ]);

    const started = Date.now();
    await kit.handle('go'); // no waitUntil: the Lambda path, where every write is on the clock

    expect(writes).toBeLessThanOrEqual(3); // one shared job-start write + the terminal one
    expect(Date.now() - started).toBeLessThan(400); // 20 serial writes would be ~1s
  });
});

describe('observability + runtime: review fixes (#60)', () => {
  it('a waitUntil that throws does not replace the run\'s result; the work runs in place', async () => {
    const batches: ObservabilityBatch[] = [];
    const kit = createEventKit(fakeSource())
      .use(observability, { sink: (b: ObservabilityBatch) => void batches.push(b) })
      .registerEvents([okEvent()]);

    const result = await kit.handle('go', { waitUntil: () => { throw new Error('boom'); } });

    expect(result.ok).toBe(true);
    expect(batches[batches.length - 1]!.invocation.status).toBe('completed');
  });

  it('shutdown() waits for end-of-invocation work still running after its response', async () => {
    const g = gate();
    const batches: ObservabilityBatch[] = [];
    // A plugin AHEAD of observability whose onInvocationEnd is still busy when shutdown runs.
    const kit = createEventKit(fakeSource())
      .use({ name: 'slow-first', async onInvocationEnd() { await g.wait; } })
      .use(observability, { persistJobsAtStart: false, sink: (b: ObservabilityBatch) => void batches.push(structuredClone(b)) })
      .registerEvents([okEvent()]);
    const w = collector();

    await kit.handle('go', { waitUntil: w.waitUntil });
    const shuttingDown = kit.shutdown();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(batches).toHaveLength(0); // nothing finalized while onInvocationEnd is still pending
    g.open();
    await shuttingDown;

    expect(batches.map(b => b.invocation.status)).toEqual(['completed']);
    expect(batches[0]!.jobs.map(j => j.status)).toEqual(['completed']);
  });

  it("one request's end-of-run flush does not wait on another request's final write", async () => {
    const g = gate();
    const kit = createEventKit(fakeSource())
      .use(observability, {
        persistJobsAtStart: false,
        sink: async (b: ObservabilityBatch) => {
          if (b.invocation.source_event_payload === 'slow') await g.wait;
        },
      })
      .registerEvents([okEvent()]);

    const slow = kit.handle('slow'); // its final write blocks on the gate
    await new Promise(resolve => setTimeout(resolve, 5));
    const fast = await Promise.race([
      kit.handle('fast').then(() => 'done'),
      new Promise(resolve => setTimeout(() => resolve('blocked'), 200)),
    ]);

    expect(fast).toBe('done');
    g.open();
    await slow;
  });
});

describe('observability: concurrent invocations on one kit', () => {
  it("one invocation's end-of-run flush does not finalize another that is still running", async () => {
    const g = gate();
    const batches: ObservabilityBatch[] = [];
    // Two invocations on the SAME kit share one observability instance: 'slow' blocks
    // inside its job while 'fast' runs to completion and runs onFlush.
    const kit = createEventKit(fakeSource())
      .use(observability, { persistJobsAtStart: false, sink: (b: ObservabilityBatch) => void batches.push(structuredClone(b)) })
      .registerEvents([
        defineFakeEvent('e', () => true, [
          job(async ctx => { if (ctx.event.envelope.payload === 'slow') await g.wait; return 'done'; }, { name: 'j' }),
        ]),
      ]);

    const slow = kit.handle('slow');
    await new Promise(resolve => setTimeout(resolve, 5)); // 'slow' is now inside its job
    await kit.handle('fast');
    g.open();
    const slowResult = await slow;

    const slowBatches = batches.filter(b => b.invocation.id === slowResult.invocationId);
    // Its only write is its own terminal one — never a premature 'running' finalization
    // that drops the buffer and loses the job's terminal state.
    expect(slowBatches).toHaveLength(1);
    expect(slowBatches[0]!.invocation.status).toBe('completed');
    expect(slowBatches[0]!.jobs.map(j => j.status)).toEqual(['completed']);
  });

  it('shutdown() writes an invocation that is still running', async () => {
    const g = gate();
    const batches: ObservabilityBatch[] = [];
    const kit = createEventKit(fakeSource())
      .use(observability, { persistJobsAtStart: false, sink: (b: ObservabilityBatch) => void batches.push(structuredClone(b)) })
      .registerEvents([defineFakeEvent('e', () => true, [job(async () => { await g.wait; return 'x'; }, { name: 'slow' })])]);

    const running = kit.handle('go');
    await new Promise(resolve => setTimeout(resolve, 5));
    await kit.shutdown();

    expect(batches.some(b => b.invocation.status === 'running')).toBe(true);
    g.open();
    await running;
  });
});

describe('batch: concurrent invocations on one kit', () => {
  const insert = (row: Record<string, unknown>) => ({
    id: 'evt',
    created_at: '2026-06-28T12:00:00.000Z',
    table: { schema: 'public', name: 'batch_jobs' },
    trigger: { name: 't' },
    event: { op: 'INSERT', data: { old: null, new: row }, session_variables: {} },
  });

  it("one invocation's end-of-run flush does not stop another row's periodic log flushing", async () => {
    const firstLogged = gate();
    const resume = gate();
    const finish = gate();
    const updates: Array<{ id: string | number; fields: BatchJobUpdate }> = [];
    const kit = createEventKit(hasuraEvent)
      .use(batch, { store: { update: (id, fields) => void updates.push({ id, fields: structuredClone(fields) }) }, logFlush: { intervalMs: 10 } })
      .registerEvents([
        {
          name: asEventName('batch.created'),
          detector: hasuraEvent.detector(ctx => ctx.operation === 'INSERT'),
          jobs: [
            job(async ctx => {
              if ((ctx.input as { slow?: boolean }).slow) {
                firstLogged.open();
                await resume.wait;
                ctx.log.info('second entry, after the other row ended');
                await finish.wait;
              }
              return 'ok';
            }, { name: 'proc' }),
          ],
        } as EventModule,
      ]);

    const slow = kit.handle(insert({ id: 1, input: { slow: true } }));
    await firstLogged.wait;
    await kit.handle(insert({ id: 2, input: {} })); // ends, and runs onFlush, while row 1 runs
    resume.open();
    await new Promise(resolve => setTimeout(resolve, 50)); // several log-flush intervals

    const periodic = updates.filter(
      u => u.id === 1 && u.fields.status === 'processing' && JSON.stringify(u.fields.output ?? {}).includes('second entry'),
    );
    expect(periodic.length).toBeGreaterThan(0); // row 1's timer survived row 2's onFlush
    finish.open();
    await slow;
  });
});

describe('batch: onFlush bookkeeping under concurrency', () => {
  it("one invocation's onFlush does not forget another invocation that ended while it was flushing", async () => {
    const releaseA = gate();
    const updates: Array<{ id: string | number; fields: BatchJobUpdate }> = [];
    const plugin = batch({
      store: {
        update: async (id, fields) => {
          updates.push({ id, fields });
          if (id === 'row-a' && fields.output) await releaseA.wait; // A's log flush is slow
        },
      },
    }) as unknown as {
      onJobStart: (ctx: unknown) => Promise<void>;
      onJobLog: (ctx: unknown, entry: unknown) => void;
      onInvocationEnd: (ctx: unknown, result: unknown) => Promise<void>;
      onFlush: () => Promise<void>;
    };
    const ctx = (invocationId: string, rowId: string) => ({
      invocationId,
      job: { name: 'proc', id: `job-${rowId}` },
      envelope: { payload: { event: { op: 'INSERT', data: { old: null, new: { id: rowId, input: {} } } } } },
    });
    const ended = { events: [] };

    // Two rows whose jobs never reached onJobEnd, B's buffered first so A's loop passes it first.
    await plugin.onJobStart(ctx('inv-b', 'row-b'));
    await plugin.onJobStart(ctx('inv-a', 'row-a'));
    plugin.onJobLog(ctx('inv-b', 'row-b'), { message: 'b' });
    plugin.onJobLog(ctx('inv-a', 'row-a'), { message: 'a' });

    await plugin.onInvocationEnd({ invocationId: 'inv-a' }, ended);
    const flushA = plugin.onFlush(); // skips row-b (B still running), then waits on row-a
    await new Promise(resolve => setTimeout(resolve, 5));
    await plugin.onInvocationEnd({ invocationId: 'inv-b' }, ended); // B ends mid-flush
    releaseA.open();
    await flushA;
    await plugin.onFlush(); // B's own flush must still find row-b

    expect(updates.some(u => u.id === 'row-b' && u.fields.output)).toBe(true);
  });
});

describe('graphqlSink: one request, and the parent-job link retry', () => {
  const batch = (extra: Record<string, unknown> = {}): ObservabilityBatch =>
    ({
      invocation: {
        id: 'i1', correlation_id: 'c1', source_system: 'hasura', status: 'completed', created_at: 'x', updated_at: 'x',
        events_detected_count: 1, total_jobs_run: 1, total_jobs_succeeded: 1, total_jobs_failed: 0, ...extra,
      },
      events: [{ id: 'e1', invocation_id: 'i1', correlation_id: 'c1', event_name: 'x', detected: true, jobs_count: 1, jobs_succeeded: 1, jobs_failed: 0, status: 'completed', created_at: 'x', updated_at: 'x' }],
      jobs: [{ id: 'j1', invocation_id: 'i1', correlation_id: 'c1', job_name: 'x', status: 'completed', result: { a: 1 }, created_at: 'x', updated_at: 'x' }],
    }) as ObservabilityBatch;
  const tablesIn = (query: string) => [...query.matchAll(/insert_(\w+)\(/g)].map(m => m[1]);

  it('sends invocation, events and jobs as ONE request by default, in FK order', async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const sink = graphqlSink({ endpoint: 'http://h/v1/graphql', request: async body => { calls.push(body); return {}; } });

    await sink(batch());

    expect(calls).toHaveLength(1);
    expect(tablesIn(calls[0]!.query)).toEqual(['invocations', 'event_executions', 'job_executions']);
    expect(Object.keys(calls[0]!.variables).sort()).toEqual(['events', 'invocations', 'jobs']);
    expect((calls[0]!.variables['invocations'] as Array<{ id: string }>)[0]!.id).toBe('i1');
  });

  it('falls back to the per-table upserts when the one request is rejected', async () => {
    const calls: string[][] = [];
    const sink = graphqlSink({
      endpoint: 'http://h/v1/graphql',
      request: async body => {
        const tables = tablesIn(body.query);
        calls.push(tables);
        // Reject the combined document; accept each single-table upsert.
        return tables.length > 1 ? ({ errors: [{ message: 'invalid input syntax for type json' }] } as never) : {};
      },
    });

    await sink(batch());

    expect(calls).toEqual([['invocations', 'event_executions', 'job_executions'], ['invocations'], ['event_executions'], ['job_executions']]);
  });

  it('retries a transport failure of the one request without falling back', async () => {
    const calls: string[][] = [];
    let attempts = 0;
    const sink = graphqlSink({
      endpoint: 'http://h/v1/graphql',
      retryDelayMs: 1,
      request: async body => {
        calls.push(tablesIn(body.query));
        attempts += 1;
        if (attempts < 2) throw new Error('network blip');
        return {};
      },
    });

    await sink(batch());

    expect(calls).toHaveLength(2);
    expect(calls.every(t => t.length === 3)).toBe(true);
  });

  const fkError = { errors: [{ message: 'Foreign key violation. constraint "fk_invocations_source_job_id"' }] };

  it('retries a missing parent-job link and keeps it once the parent row lands', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let misses = 2;
    const sink = graphqlSink({
      endpoint: 'http://h/v1/graphql',
      singleRequest: false,
      sourceJobLinkRetryMs: [1, 1],
      request: async body => {
        if (/insert_invocations/.test(body.query)) {
          sent.push((body.variables as { objects: Record<string, unknown>[] }).objects[0]!);
          if (misses-- > 0) return fkError as never;
        }
        return {};
      },
    });

    await sink(batch({ source_job_id: 'parent-job' }), { deferred: true });

    expect(sent).toHaveLength(3); // two misses, then it landed
    expect(sent.every(o => o['source_job_id'] === 'parent-job')).toBe(true);
  });

  it('by default retries the link after 250ms and again after 1s', async () => {
    vi.useFakeTimers();
    try {
      const sent: Array<Record<string, unknown>> = [];
      const sink = graphqlSink({
        endpoint: 'http://h/v1/graphql',
        singleRequest: false,
        request: async body => {
          if (/insert_invocations/.test(body.query)) {
            const obj = (body.variables as { objects: Record<string, unknown>[] }).objects[0]!;
            sent.push(obj);
            if ('source_job_id' in obj) return fkError as never;
          }
          return {};
        },
      });

      const writing = sink(batch({ source_job_id: 'late-parent' }), { deferred: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(sent).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1000);
      await writing;
      expect(sent).toHaveLength(4); // the third attempt failed too, so the link was dropped
      expect(sent[3]).not.toHaveProperty('source_job_id');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the link only after the retries run out', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const sink = graphqlSink({
      endpoint: 'http://h/v1/graphql',
      singleRequest: false,
      sourceJobLinkRetryMs: [1, 1],
      request: async body => {
        if (/insert_invocations/.test(body.query)) {
          const obj = (body.variables as { objects: Record<string, unknown>[] }).objects[0]!;
          sent.push(obj);
          if ('source_job_id' in obj) return fkError as never;
        }
        return {};
      },
    });

    await sink(batch({ source_job_id: 'never-lands' }), { deferred: true });

    expect(sent).toHaveLength(4); // first try + two retries with the link, then without
    expect(sent.slice(0, 3).every(o => 'source_job_id' in o)).toBe(true);
    expect(sent[3]).not.toHaveProperty('source_job_id');
  });

  it('a write the response waits on drops a missing link at once, as before 0.8.0', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const sink = graphqlSink({
      endpoint: 'http://h/v1/graphql',
      singleRequest: false,
      request: async body => {
        if (/insert_invocations/.test(body.query)) {
          const obj = (body.variables as { objects: Record<string, unknown>[] }).objects[0]!;
          sent.push(obj);
          if ('source_job_id' in obj) return fkError as never;
        }
        return {};
      },
    });

    const started = Date.now();
    await sink(batch({ source_job_id: 'never-lands' })); // no info: not deferred

    expect(sent).toHaveLength(2); // with the link, then without — no backoff
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("remembers a link it gave up on, so the invocation's next write drops it at once", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const sink = graphqlSink({
      endpoint: 'http://h/v1/graphql',
      singleRequest: false,
      sourceJobLinkRetryMs: [1, 1],
      request: async body => {
        if (/insert_invocations/.test(body.query)) {
          const obj = (body.variables as { objects: Record<string, unknown>[] }).objects[0]!;
          sent.push(obj);
          if ('source_job_id' in obj) return fkError as never;
        }
        return {};
      },
    });

    await sink(batch({ source_job_id: 'never-lands' }), { deferred: true });
    sent.length = 0;
    await sink(batch({ source_job_id: 'never-lands' }), { deferred: true });

    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('source_job_id');
  });

  it("remembers an invocation whose one request was rejected and goes straight to per-table next time", async () => {
    const calls: string[][] = [];
    const sink = graphqlSink({
      endpoint: 'http://h/v1/graphql',
      request: async body => {
        const tables = tablesIn(body.query);
        calls.push(tables);
        return tables.length > 1 ? ({ errors: [{ message: 'field "error_stack" not found' }] } as never) : {};
      },
    });

    await sink(batch());
    calls.length = 0;
    await sink(batch());

    expect(calls).toEqual([['invocations'], ['event_executions'], ['job_executions']]);
  });

  it("the invocation's final write tries a given-up link once more, and keeps it if the parent has landed", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let parentLanded = false;
    const sink = graphqlSink({
      endpoint: 'http://h/v1/graphql',
      singleRequest: false,
      sourceJobLinkRetryMs: [1, 1],
      request: async body => {
        if (/insert_invocations/.test(body.query)) {
          const obj = (body.variables as { objects: Record<string, unknown>[] }).objects[0]!;
          sent.push(obj);
          if ('source_job_id' in obj && !parentLanded) return fkError as never;
        }
        return {};
      },
    });

    await sink(batch({ source_job_id: 'late-parent' }), { deferred: true, final: false }); // gives up
    parentLanded = true;
    sent.length = 0;
    const started = Date.now();
    await sink(batch({ source_job_id: 'late-parent' }), { deferred: true, final: true });

    expect(sent).toHaveLength(1); // one try with the link, no backoff
    expect(sent[0]!['source_job_id']).toBe('late-parent');
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("the final write drops a still-missing link after that one try, without waiting", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const sink = graphqlSink({
      endpoint: 'http://h/v1/graphql',
      singleRequest: false,
      sourceJobLinkRetryMs: [1, 1],
      request: async body => {
        if (/insert_invocations/.test(body.query)) {
          const obj = (body.variables as { objects: Record<string, unknown>[] }).objects[0]!;
          sent.push(obj);
          if ('source_job_id' in obj) return fkError as never;
        }
        return {};
      },
    });

    await sink(batch({ source_job_id: 'never-lands' }), { deferred: true, final: false }); // gives up
    sent.length = 0;
    await sink(batch({ source_job_id: 'never-lands' }), { deferred: true, final: true });

    expect(sent.map(o => 'source_job_id' in o)).toEqual([true, false]);
  });
});
