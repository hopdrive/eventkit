import { describe, it, expect } from 'vitest';
import { createEventKit, defineEvent, job, ActionError, ClientError, type EventKitPlugin, type JobContext } from '../../index.js';
import { fakeSource, defineFakeEvent } from '../../testing/index.js';
import { netlifyBackgroundPlatform } from '../../plugins/platforms.js';

// A detector that always fires. Modules are declarative (ADR-025): a static `jobs`
// array + optional `prepare`/`run`, never a handler that calls run().
const always = () => true;
const asName = (n: string) => n as unknown as ReturnType<typeof defineEvent>['name'];

describe('no-plugin kit: detect + run the declared jobs in-memory', () => {
  it('detects a registered event and runs its jobs end to end', async () => {
    const ran: string[] = [];
    const mod = defineFakeEvent('thing.happened', ctx => ctx.payload === 'go', [
      job(() => { ran.push('a'); return { ok: true }; }, { name: 'jobA' }),
      job(() => { ran.push('b'); return 42; }, { name: 'jobB' }),
    ]);

    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    const result = await kit.handle('go');

    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.name).toBe('thing.happened');
    const jobs = result.events[0]!.jobs;
    expect(jobs.map(j => j.jobName).sort()).toEqual(['jobA', 'jobB']);
    expect(jobs.every(j => j.status === 'completed')).toBe(true);
    expect(jobs.find(j => j.jobName === 'jobB')!.output).toBe(42);
    expect(ran.sort()).toEqual(['a', 'b']);
  });

  it('does not fire when the detector returns false', async () => {
    const mod = defineFakeEvent('thing.happened', () => false, []);
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    const result = await kit.handle('nope');
    expect(result.events).toHaveLength(0);
  });
});

describe('ADR-025: jobs is a static array — non-job entries throw at REGISTER time', () => {
  // Conditional inclusion is impossible by construction (no handler body); the brand
  // + a register-time check are the backstop, surfaced BEFORE any invocation runs.
  it('throws on a falsy entry (the old `cond && job()`)', () => {
    const mod = defineFakeEvent('e', always, [false as never]);
    expect(() => createEventKit(fakeSource()).registerEvents([mod])).toThrow(/jobs\[0\] is not a job/);
  });

  it('throws on null/undefined entries', () => {
    const mod = defineFakeEvent('e', always, [null as never, undefined as never]);
    expect(() => createEventKit(fakeSource()).registerEvents([mod])).toThrow(/is not a job/);
  });

  it('throws when jobs is not an array', () => {
    const mod = { name: 'e', detector: always, jobs: 'nope' } as never;
    expect(() => createEventKit(fakeSource()).registerEvents([mod])).toThrow(/jobs must be a static array/);
  });
});

describe('ADR-025 (amended): a bare job function is auto-wrapped with job(fn)', () => {
  it('runs a bare function and derives its name from fn.name', async () => {
    let ran = false;
    function notifyDriver() { ran = true; return { ok: true }; }
    // bare function — no job() wrapper, no options
    const mod = defineFakeEvent('move.active.change', always, [notifyDriver as never]);
    const result = await createEventKit(fakeSource()).registerEvents([mod]).handle('go');

    expect(ran).toBe(true);
    expect(result.events[0]!.jobs[0]!.jobName).toBe('notifyDriver'); // name from fn.name
    expect(result.events[0]!.jobs[0]!.status).toBe('completed');
    expect(result.ok).toBe(true);
  });

  it('mixes bare functions and job(fn, opts) in one array', async () => {
    const ran: string[] = [];
    function runAR() { ran.push('runAR'); }
    const mod = defineFakeEvent('e', always, [runAR as never, job(() => void ran.push('retryable'), { name: 'withOpts', retries: 1 })]);
    const result = await createEventKit(fakeSource()).registerEvents([mod]).handle('go');

    expect(ran.sort()).toEqual(['runAR', 'retryable'].sort());
    expect(result.events[0]!.jobs.map(j => j.jobName).sort()).toEqual(['runAR', 'withOpts']);
  });

  it('still rejects a non-function, non-job entry at register time', () => {
    const mod = { name: 'e', detector: always, jobs: [{ fn: () => {}, name: 'x' }] } as never; // look-alike, no brand
    expect(() => createEventKit(fakeSource()).registerEvents([mod])).toThrow(/is not a job\(fn\) or a job function/);
  });
});

describe('ADR-025 prepare: runs once before the jobs; output merges into every job input', () => {
  it('calls prepare exactly once for the whole event, regardless of job count', async () => {
    let prepareCalls = 0;
    const mod = defineFakeEvent(
      'e',
      always,
      [job(() => {}, { name: 'a' }), job(() => {}, { name: 'b' }), job(() => {}, { name: 'c' })],
      { prepare: () => { prepareCalls += 1; return { shared: true }; } },
    );
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    await kit.handle('x');
    expect(prepareCalls).toBe(1);
  });

  it('merge precedence is plugin baselines → prepare → per-job input (highest wins)', async () => {
    const baseliner: EventKitPlugin = {
      name: 'baseliner',
      augmentJobContext: () => ({ input: { a: 'baseline', b: 'baseline', c: 'baseline' } }),
    };
    let seen: Record<string, unknown> | undefined;
    const mod = defineFakeEvent(
      'e',
      always,
      [job((ctx: JobContext) => { seen = ctx.input as Record<string, unknown>; }, { input: { c: 'job' } })],
      { prepare: () => ({ b: 'prepare', c: 'prepare' }) },
    );
    const kit = createEventKit(fakeSource()).use(baseliner).registerEvents([mod]);
    await kit.handle('x');
    expect(seen).toEqual({ a: 'baseline', b: 'prepare', c: 'job' });
  });

  it('resolves a per-job input MAPPER against the event/prepared at job-build time', async () => {
    let seen: Record<string, unknown> | undefined;
    const mod = defineFakeEvent(
      'e',
      always,
      [
        job((ctx: JobContext) => { seen = ctx.input as Record<string, unknown>; }, {
          // mapper sees the (fake) handler context + prepared; never its own input
          input: (ctx: { payload?: unknown; prepared: { tenant?: string } }) => ({ from: ctx.payload, tenant: ctx.prepared.tenant }),
        }),
      ],
      { prepare: () => ({ tenant: 'acme' }) },
    );
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    await kit.handle('payload-value');
    expect(seen).toEqual({ tenant: 'acme', from: 'payload-value' });
  });
});

describe('ADR-020: augmentJobContext merge order + ambient trackingToken', () => {
  it('merges plugin input baselines UNDER per-job input (job keys win)', async () => {
    const baseliner: EventKitPlugin = {
      name: 'baseliner',
      augmentJobContext: () => ({ input: { a: 'plugin', b: 'plugin' } }),
    };
    let seen: Record<string, unknown> | undefined;
    const mod = defineFakeEvent('e', always, [
      job((ctx: JobContext) => { seen = ctx.input as Record<string, unknown>; }, { input: { b: 'job', c: 'job' } }),
    ]);

    const kit = createEventKit(fakeSource()).use(baseliner).registerEvents([mod]);
    await kit.handle('x');
    expect(seen).toEqual({ a: 'plugin', b: 'job', c: 'job' });
  });

  it('exposes a deterministic default trackingToken, overridable by a plugin', async () => {
    let token = '';
    const mod = defineFakeEvent('e', always, [job((ctx: JobContext) => void (token = ctx.trackingToken))]);
    const kit = createEventKit(fakeSource({ correlationId: 'corr-1' })).registerEvents([mod]);
    await kit.handle('x');
    expect(token).toBe('fake.corr-1.' + token.split('.')[2]);
    expect(token.startsWith('fake.corr-1.')).toBe(true);

    const overrider: EventKitPlugin = {
      name: 'overrider',
      augmentJobContext: () => ({ ambient: { trackingToken: 'custom-token' } }),
    };
    let token2 = '';
    const mod2 = defineFakeEvent('e', always, [job((ctx: JobContext) => void (token2 = ctx.trackingToken))]);
    const kit2 = createEventKit(fakeSource()).use(overrider).registerEvents([mod2]);
    await kit2.handle('x');
    expect(token2).toBe('custom-token');
  });
});

describe('ADR-014: run defaults parallel + continueOnFailure', () => {
  it('a failing job does not block the others (parallel default)', async () => {
    const mod = defineFakeEvent('e', always, [
      job(() => { throw new Error('boom'); }, { name: 'bad' }),
      job(() => 'ok', { name: 'good' }),
    ]);
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    const result = await kit.handle('x');
    const jobs = result.events[0]!.jobs;
    expect(jobs.find(j => j.jobName === 'bad')!.status).toBe('failed');
    expect(jobs.find(j => j.jobName === 'bad')!.error?.message).toBe('boom');
    expect(jobs.find(j => j.jobName === 'good')!.status).toBe('completed');
    expect(result.ok).toBe(false);
  });

  it('series + continueOnFailure:false stops and marks the rest skipped (run options on the module)', async () => {
    const ran: string[] = [];
    const mod = defineFakeEvent(
      'e',
      always,
      [
        job(() => void ran.push('1'), { name: 'one' }),
        job(() => { ran.push('2'); throw new Error('stop here'); }, { name: 'two' }),
        job(() => void ran.push('3'), { name: 'three' }),
      ],
      { run: { mode: 'series', continueOnFailure: false } },
    );
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    const result = await kit.handle('x');
    const byName = Object.fromEntries(result.events[0]!.jobs.map(j => [j.jobName, j.status]));
    expect(byName).toEqual({ one: 'completed', two: 'failed', three: 'skipped' });
    expect(ran).toEqual(['1', '2']); // job three never ran
  });
});

describe('timeouts and cancellation', () => {
  it('marks a job that exceeds its timeoutMs as timed_out', async () => {
    const mod = defineFakeEvent('e', always, [job(() => new Promise(() => {}), { name: 'slow', timeoutMs: 25 })]);
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    const result = await kit.handle('x');
    expect(result.events[0]!.jobs[0]!.status).toBe('timed_out');
  });

  it('cancels in-flight jobs when the serverless budget expires', async () => {
    const mod = defineFakeEvent('e', always, [job(() => new Promise(resolve => setTimeout(resolve, 1000)), { name: 'longrunner' })]);
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    // budget = 250 - 200 (flush margin) = 50ms before abort fires
    const result = await kit.handle('x', { getRemainingTimeMs: () => 250 });
    expect(result.events[0]!.jobs[0]!.status).toBe('cancelled');
    expect(result.timedOut).toBe(true);
  });

  it('retries a failing job up to retries+1 attempts', async () => {
    let attempts = 0;
    const mod = defineFakeEvent('e', always, [
      job(() => { attempts += 1; if (attempts < 3) throw new Error('flaky'); return 'finally'; }, { name: 'flaky', retries: 2 }),
    ]);
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    const result = await kit.handle('x');
    expect(attempts).toBe(3);
    expect(result.events[0]!.jobs[0]!.status).toBe('completed');
    expect(result.events[0]!.jobs[0]!.attempt).toBe(3);
  });
});

describe('observability parity: crashes surface in events[] without flipping ok (no-retry contract)', () => {
  it('a prepare crash → detected:true, no jobs, error set, ok stays true', async () => {
    const mod = defineFakeEvent('e', always, [job(() => 'ok', { name: 'j' })], {
      prepare: () => { throw new Error('prepare boom'); },
    });
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    const result = await kit.handle('x');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.detected).toBe(true); // event WAS detected; prepare failed
    expect(result.events[0]!.jobs).toEqual([]);
    expect(result.events[0]!.error?.message).toBe('prepare boom');
    expect(result.ok).toBe(true); // no failed jobs → not flipped → no 5xx → no Hasura retry
  });

  it('a detector crash → detected:false, no jobs, error set, ok stays true', async () => {
    const mod = defineFakeEvent('e', () => { throw new Error('detector boom'); }, []);
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    const result = await kit.handle('x');
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.detected).toBe(false);
    expect(result.events[0]!.jobs).toEqual([]);
    expect(result.events[0]!.error?.message).toBe('detector boom');
    expect(result.ok).toBe(true);
  });

  it('a cleanly-false detector produces no event entry', async () => {
    const mod = defineFakeEvent('e', () => false, []);
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    const result = await kit.handle('x');
    expect(result.events).toHaveLength(0);
  });
});

describe('plugin lifecycle + capability validation', () => {
  it('fans out notifications in registration order', async () => {
    const calls: string[] = [];
    const p1: EventKitPlugin = { name: 'p1', onInvocationStart: () => void calls.push('p1') };
    const p2: EventKitPlugin = { name: 'p2', onInvocationStart: () => void calls.push('p2') };
    const mod = defineFakeEvent('e', always, []);
    const kit = createEventKit(fakeSource()).use(p1).use(p2).registerEvents([mod]);
    await kit.handle('x');
    // source is registration[0]; the two plugins fire in order after it
    expect(calls).toEqual(['p1', 'p2']);
  });

  it('throws when a plugin requires an unsatisfied capability', async () => {
    const needsHasura: EventKitPlugin = { name: 'needs-hasura', requires: ['source:hasura'] };
    const mod = defineFakeEvent('e', always, []);
    const kit = createEventKit(fakeSource()).use(needsHasura).registerEvents([mod]);
    await expect(kit.handle('x')).rejects.toThrow(/requires capability 'source:hasura'/);
  });

  it('throws when two plugins claim the same singleton role', () => {
    const fakeA = fakeSource();
    const dupeSource: EventKitPlugin = { name: 'dupe', provides: ['source'] };
    const kit = createEventKit(fakeA).use(dupeSource);
    expect(() => kit.validate()).toThrow(/claim the 'source' capability/);
  });
});

describe('ADR-026: resolve (request/response) is source-agnostic; jobs run alongside', () => {
  it("surfaces resolve's return on result.resolved while a fire-and-forget job runs too", async () => {
    let jobRan = false;
    const mod = defineEvent({
      name: 'rpc.compute',
      detector: always,
      prepare: () => ({ base: 10 }),
      resolve: ctx => ({ total: (ctx.prepared as { base: number }).base + 5 }),
      jobs: [job(() => void (jobRan = true), { name: 'sideEffect' })],
    });
    const result = await createEventKit(fakeSource()).registerEvents([mod]).handle('go');

    expect(result.resolved?.hasResolved).toBe(true);
    expect(result.resolved?.output).toEqual({ total: 15 }); // resolve saw prepare output
    expect(jobRan).toBe(true);
    expect(result.events[0]!.jobs[0]!.status).toBe('completed');
    expect(result.ok).toBe(true);
  });

  it('a fire-and-forget module (no resolve) leaves result.resolved undefined', async () => {
    const mod = defineEvent({ name: 'plain', detector: always, jobs: [job(() => 'ok')] });
    const result = await createEventKit(fakeSource()).registerEvents([mod]).handle('go');
    expect(result.resolved).toBeUndefined();
  });

  it('a resolve throw → result.resolved.error; jobs still ran; ok stays job-status-only', async () => {
    let jobRan = false;
    const mod = defineEvent({
      name: 'rpc.fails',
      detector: always,
      resolve: () => { throw new Error('compute failed'); },
      jobs: [job(() => void (jobRan = true))],
    });
    const result = await createEventKit(fakeSource()).registerEvents([mod]).handle('go');

    expect(result.resolved?.error?.message).toBe('compute failed');
    expect(result.resolved?.output).toBeUndefined();
    expect(jobRan).toBe(true);
    expect(result.ok).toBe(true); // resolve error maps to the wire, not to a job-failure retry
  });

  it('carries ClientError.status and ActionError.code onto resolved.error (duck-typed)', async () => {
    const ce = await createEventKit(fakeSource())
      .registerEvents([defineEvent({ name: 'pay', detector: always, resolve: () => { throw new ClientError(402, 'payment required'); } })])
      .handle('go');
    expect(ce.resolved?.error).toMatchObject({ message: 'payment required', status: 402 });

    const ae = await createEventKit(fakeSource())
      .registerEvents([defineEvent({ name: 'act', detector: always, resolve: () => { throw new ActionError('nope', 'BAD_INPUT', { field: 'email' }); } })])
      .handle('go');
    expect(ae.resolved?.error).toMatchObject({ message: 'nope', code: 'BAD_INPUT', extensions: { field: 'email' } });
  });

  it('register-time: a module with neither jobs nor resolve throws', () => {
    const bad = { name: asName('does.nothing'), detector: always } as unknown as ReturnType<typeof defineEvent>;
    expect(() => createEventKit(fakeSource()).registerEvents([bad])).toThrow(/must declare 'jobs' and\/or 'resolve'/);
  });
});

describe('ADR-026 amendment: respond (result-driven response) runs after jobs and reads results', () => {
  it('sequences respond AFTER the jobs settle and hands it their executions + ok', async () => {
    const order: string[] = [];
    const mod = defineEvent({
      name: 'rpc.afterjobs',
      detector: always,
      jobs: [
        job(() => { order.push('a'); return 2; }, { name: 'a' }),
        job(() => { order.push('b'); return 3; }, { name: 'b' }),
      ],
      respond: (_ctx, { jobs, ok }) => {
        order.push('respond');
        const sum = jobs.reduce((n, j) => n + ((j.output as number) ?? 0), 0);
        return { ok, sum, ran: jobs.length };
      },
    });
    const result = await createEventKit(fakeSource()).registerEvents([mod]).handle('go');

    expect(order).toEqual(['a', 'b', 'respond']); // respond runs last, after both jobs
    expect(result.resolved?.hasResolved).toBe(true);
    expect(result.resolved?.output).toEqual({ ok: true, sum: 5, ran: 2 }); // composed from job outputs
    expect(result.ok).toBe(true);
  });

  it('respond sees a failed job (ok=false) and can map it to an error response', async () => {
    const mod = defineEvent({
      name: 'rpc.partialfail',
      detector: always,
      run: { continueOnFailure: true },
      jobs: [
        job(() => 'ok', { name: 'good' }),
        job(() => { throw new Error('boom'); }, { name: 'bad' }),
      ],
      respond: (_ctx, { jobs, ok }) => {
        if (!ok) throw new ClientError(502, `failed: ${jobs.filter(j => j.status !== 'completed').map(j => j.jobName).join(',')}`);
        return { ok: true };
      },
    });
    const result = await createEventKit(fakeSource()).registerEvents([mod]).handle('go');

    expect(result.resolved?.error).toMatchObject({ status: 502 });
    expect(result.resolved?.error?.message).toContain('bad');
    expect(result.ok).toBe(false); // a job genuinely failed (job-status-only)
  });

  it('register-time: declaring both resolve and respond throws (one response timing)', () => {
    const bad = defineEvent({ name: 'both', detector: always, jobs: [job(() => 1)], resolve: () => 1, respond: () => 2 });
    expect(() => createEventKit(fakeSource()).registerEvents([bad])).toThrow(/'resolve' OR 'respond'/);
  });

  it('register-time: respond without jobs throws (it reads job results)', () => {
    const bad = defineEvent({ name: 'norjobs', detector: always, respond: () => 1 });
    expect(() => createEventKit(fakeSource()).registerEvents([bad])).toThrow(/'respond' requires at least one job/);
  });

  it('validate(): respond is rejected under a deferredResponse (background/202) platform', () => {
    const mod = defineEvent({ name: 'bg', detector: always, jobs: [job(() => 1)], respond: () => 1 });
    const kit = createEventKit(fakeSource()).use(netlifyBackgroundPlatform).registerEvents([mod]);
    expect(() => kit.validate()).toThrow(/incompatible with platform/);
  });
});
