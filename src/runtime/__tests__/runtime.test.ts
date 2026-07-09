import { describe, it, expect } from 'vitest';
import { createEventKit, defineEvent, job, ActionError, ClientError, type EventKitPlugin, type EventEnvelope, type JobContext } from '../../index.js';
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

  it('throws when two modules register the same event name', () => {
    const a = defineFakeEvent('same.name', always, [job(() => {})]);
    const b = defineFakeEvent('same.name', always, [job(() => {})]);
    expect(() => createEventKit(fakeSource()).registerEvents([a, b])).toThrow(/Duplicate event name registered.*same\.name/);
    // also across separate register calls on the same kit
    const kit = createEventKit(fakeSource()).registerEvents([defineFakeEvent('same.name', always, [job(() => {})])]);
    expect(() => kit.registerEvents([defineFakeEvent('same.name', always, [job(() => {})])])).toThrow(/Duplicate event name registered/);
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

describe('ADR-014: jobs run parallel + isolated (series deferred, ADR-031)', () => {
  it('a failing job does not block the others (parallel, isolated failures)', async () => {
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

  it('registering a module with run.mode: series fails loud (ADR-031)', () => {
    const mod = defineFakeEvent('e', always, [job(() => 'ok', { name: 'one' })]);
    // RunOptions no longer types `mode`; force the legacy/untyped shape.
    (mod as { run?: unknown }).run = { mode: 'series' };
    expect(() => createEventKit(fakeSource()).registerEvents([mod])).toThrow(
      /not available in this release \(ADR-031\)/,
    );
  });

  it('registering a job with continueOnFailure fails loud (ADR-031)', () => {
    const badJob = job(() => 'ok', { name: 'one' });
    (badJob.options as { continueOnFailure?: boolean }).continueOnFailure = false;
    const mod = defineFakeEvent('e', always, [badJob]);
    expect(() => createEventKit(fakeSource()).registerEvents([mod])).toThrow(
      /not available in this release \(ADR-031\)/,
    );
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

describe("ADR-026 (re-amended): the invocation reply is declared at kit.handler({ after })", () => {
  it('{ body }: the constant body becomes the reply; job failures cannot change it', async () => {
    const handler = createEventKit(fakeSource())
      .registerEvents([
        defineEvent({
          name: 'fixed.ack',
          detector: always,
          jobs: [job(() => { throw new Error('job blew up'); }, { name: 'boom' })],
        }),
      ])
      .handler({ after: { body: { received: true } } });
    const result = (await handler('go')) as Awaited<ReturnType<ReturnType<typeof createEventKit>['handle']>>;

    expect(result.resolved).toMatchObject({ hasResolved: true, output: { received: true } });
    expect(result.resolved?.error).toBeUndefined();
    expect(result.ok).toBe(false); // the job failure still shows in job status (Batch's concern)
  });

  it('{ fromResults }: receives the FULL typed rollup — every detected event and all job executions', async () => {
    const handler = createEventKit(fakeSource())
      .registerEvents([
        defineEvent({ name: 'payment.received', detector: always, jobs: [job(() => ({ charged: 42 }), { name: 'charge' })] }),
        defineEvent({ name: 'payment.audit.logged', detector: always, jobs: [job(() => 'audited', { name: 'audit' })] }),
      ])
      .handler({
        after: {
          fromResults: result => ({
            ok: result.ok,
            events: result.events.map(e => e.name),
            charged: (result.events[0]!.jobs[0]!.output as { charged: number }).charged,
          }),
        },
      });
    const result = (await handler('go')) as Awaited<ReturnType<ReturnType<typeof createEventKit>['handle']>>;

    expect(result.resolved?.output).toEqual({
      ok: true,
      events: ['payment.received', 'payment.audit.logged'], // cross-event composition
      charged: 42,
    });
  });

  it('{ fromResults } throw: ClientError/ActionError map to the wire error (duck-typed)', async () => {
    const make = (afterFn: () => never) =>
      createEventKit(fakeSource())
        .registerEvents([defineEvent({ name: 'e', detector: always, jobs: [job(() => 1)] })])
        .handler({ after: { fromResults: afterFn } });

    const ce = (await make(() => { throw new ClientError(402, 'payment required'); })('go')) as Awaited<ReturnType<ReturnType<typeof createEventKit>['handle']>>;
    expect(ce.resolved?.error).toMatchObject({ message: 'payment required', status: 402 });

    const ae = (await make(() => { throw new ActionError('nope', 'BAD_INPUT', { field: 'email' }); })('go')) as Awaited<ReturnType<ReturnType<typeof createEventKit>['handle']>>;
    expect(ae.resolved?.error).toMatchObject({ message: 'nope', code: 'BAD_INPUT', extensions: { field: 'email' } });
    expect(ae.ok).toBe(true); // an after error maps to the wire, never to a job-failure retry
  });

  it('ResponseWire: declared status/headers land on the PRODUCED reply only', async () => {
    const ok = (await createEventKit(fakeSource())
      .registerEvents([defineEvent({ name: 'twiml', detector: always, jobs: [job(() => 1)] })])
      .handler({ after: { body: '<Response/>', status: 201, headers: { 'content-type': 'text/xml' } } })('go')) as Awaited<ReturnType<ReturnType<typeof createEventKit>['handle']>>;
    expect(ok.resolved).toMatchObject({ output: '<Response/>', status: 201, headers: { 'content-type': 'text/xml' } });

    // On a throw, the error mapping owns the wire — declared wire fields are NOT attached.
    const err = (await createEventKit(fakeSource())
      .registerEvents([defineEvent({ name: 'e', detector: always, jobs: [job(() => 1)] })])
      .handler({ after: { fromResults: () => { throw new ClientError(422, 'nope'); }, status: 201, headers: { 'x-a': '1' } } })('go')) as Awaited<ReturnType<ReturnType<typeof createEventKit>['handle']>>;
    expect(err.resolved?.error).toMatchObject({ status: 422 });
    expect(err.resolved?.status).toBeUndefined();
    expect(err.resolved?.headers).toBeUndefined();
  });

  it('after is SKIPPED on a framework error — the 500 retry contract is load-bearing', async () => {
    const brokenSource: EventKitPlugin = {
      name: 'broken',
      provides: ['source'],
      normalize: () => { throw new Error('normalize blew up'); },
    } as EventKitPlugin;
    const result = (await createEventKit(brokenSource)
      .registerEvents([defineEvent({ name: 'e', detector: always, jobs: [job(() => 1)] })])
      .handler({ after: { body: { received: true } } })('go')) as Awaited<ReturnType<ReturnType<typeof createEventKit>['handle']>>;

    expect(result.error?.message).toContain('normalize blew up'); // still the retryable framework error
    expect(result.resolved).toBeUndefined(); // the ack did NOT mask it
  });

  it('handler creation fails fast on a malformed after declaration', () => {
    const kit = () => createEventKit(fakeSource()).registerEvents([defineEvent({ name: 'e', detector: always, jobs: [job(() => 1)] })]);
    expect(() => kit().handler({ after: {} as never })).toThrow(/exactly one of/);
    expect(() => kit().handler({ after: { body: { a: 1 }, fromResults: () => 1 } as never })).toThrow(/exactly one of/);
    expect(() => kit().handler({ after: { body: (() => 1) as never } })).toThrow(/CONSTANT reply/);
    expect(() => kit().handler({ after: { body: Promise.resolve(1) as never } })).toThrow(/CONSTANT reply/);
    expect(() => kit().handler({ after: { fromResults: 'nope' as never } })).toThrow(/must be a function/);
    expect(() => kit().handler({ after: { body: { a: 1 }, status: '201' as never } })).toThrow(/integer HTTP status/);
    expect(() => kit().handler({ after: { body: { a: 1 }, headers: ['x'] as never } })).toThrow(/record of header strings/);
  });

  it('register-time: a module carrying the removed resolve/respond/response fields points at kit.handler({ after })', () => {
    for (const field of ['resolve', 'respond', 'response'] as const) {
      const legacy = { name: asName('old.' + field), detector: always, jobs: [job(() => 1)], [field]: () => 1 } as unknown as ReturnType<typeof defineEvent>;
      expect(() => createEventKit(fakeSource()).registerEvents([legacy])).toThrow(/declare it at the invocation layer/);
    }
  });

  it('register-time: a module with no jobs throws (a module does nothing without them)', () => {
    const bad = { name: asName('does.nothing'), detector: always } as unknown as ReturnType<typeof defineEvent>;
    expect(() => createEventKit(fakeSource()).registerEvents([bad])).toThrow(/must declare 'jobs'/);
  });
});

describe('ADR-033: pre-dispatch pipeline hardening', () => {
  // A spy plugin that records onError fan-outs and counts the always-runs flush hooks.
  function spy() {
    const s = { errors: [] as unknown[], flushed: 0, ended: 0 };
    const plugin: EventKitPlugin = {
      name: 'spy',
      onError: ctx => { s.errors.push(ctx); },
      onFlush: () => { s.flushed++; },
      onInvocationEnd: () => { s.ended++; },
    };
    return { s, plugin };
  }

  it('isolates a throwing configureInvocation: onError fires, the event still dispatches, flush + end still run', async () => {
    let jobRan = false;
    const mod = defineFakeEvent('e', always, [job(() => void (jobRan = true), { name: 'j' })]);
    const { s, plugin } = spy();
    const thrower: EventKitPlugin = { name: 'thrower', configureInvocation: () => { throw new Error('config boom'); } };
    const result = await createEventKit(fakeSource()).use(plugin).use(thrower).registerEvents([mod]).handle('go');

    expect(jobRan).toBe(true);            // one plugin throwing did NOT sink the pipeline
    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(s.errors.length).toBeGreaterThanOrEqual(1); // routed to onError
    expect(s.flushed).toBe(1);            // onFlush ran (finally)
    expect(s.ended).toBe(1);              // onInvocationEnd ran (finally)
  });

  it('isolates a throwing augmentEnvelope: onError fires, the event still dispatches, flush runs', async () => {
    let jobRan = false;
    const mod = defineFakeEvent('e', always, [job(() => void (jobRan = true), { name: 'j' })]);
    const { s, plugin } = spy();
    const thrower: EventKitPlugin = { name: 'thrower', augmentEnvelope: () => { throw new Error('augment boom'); } };
    const result = await createEventKit(fakeSource()).use(plugin).use(thrower).registerEvents([mod]).handle('go');

    expect(jobRan).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(s.errors.length).toBeGreaterThanOrEqual(1);
    expect(s.flushed).toBe(1);
  });

  it('a non-ClientError with a numeric .status thrown pre-dispatch → framework 500 (ok:false), never a false ok:true', async () => {
    // The exact P0-2 hazard: a DB blip whose error carries a numeric `.status`. The old
    // bare `.status` duck-type would have returned ok:true with the error swallowed.
    const badSource = {
      name: 'bad-source',
      provides: ['source', 'source:bad'],
      sourceType: 'application',
      normalize: () => { throw Object.assign(new Error('db blip'), { status: 500 }); },
    } as unknown as EventKitPlugin;
    const { s, plugin } = spy();
    const mod = defineFakeEvent('e', always, [job(() => {})]);
    const result = await createEventKit(badSource).use(plugin).registerEvents([mod]).handle('go');

    expect(result.ok).toBe(false);              // framework 500 → the vendor retries
    expect(result.error?.message).toBe('db blip');
    expect(result.resolved).toBeUndefined();    // NOT the swallowed-into-success path
    expect(s.flushed).toBe(1);                  // flush still ran on the error path
  });

  it('a branded ClientError thrown pre-dispatch maps to its wire status (ok:true, resolved.error)', async () => {
    // rejectUnverified-style: an intentional, branded ClientError is re-thrown by the
    // isolated pipeline and maps to the wire status — never isolated as a bug.
    const rejecter: EventKitPlugin = { name: 'rejecter', augmentEnvelope: () => { throw new ClientError(401, 'forged'); } };
    const mod = defineFakeEvent('e', always, [job(() => {})]);
    const result = await createEventKit(fakeSource()).use(rejecter).registerEvents([mod]).handle('go');

    expect(result.ok).toBe(true);
    expect(result.resolved?.error).toMatchObject({ status: 401, message: 'forged' });
    expect(result.events).toHaveLength(0);       // never dispatched
    expect(result.error).toBeUndefined();        // not a framework 500
  });

  it('deep-merges augmentEnvelope meta: a later plugin adding a key preserves an earlier plugin\'s meta', async () => {
    const first: EventKitPlugin = { name: 'first', augmentEnvelope: (): Partial<EventEnvelope> => ({ meta: { sourceTrackingToken: 'tok-123' } }) };
    const second: EventKitPlugin = { name: 'second', augmentEnvelope: (): Partial<EventEnvelope> => ({ meta: { otherKey: 'x' } }) };
    let seen: Record<string, unknown> | undefined;
    const mod = defineFakeEvent('e', always, [job(ctx => { seen = ctx.envelope.meta as Record<string, unknown>; }, { name: 'peek' })]);
    await createEventKit(fakeSource()).use(first).use(second).registerEvents([mod]).handle('go');

    expect(seen).toMatchObject({ sourceTrackingToken: 'tok-123', otherKey: 'x' }); // second did NOT wipe first
  });
});

describe('ADR-035: ctx.skip(reason) — a job self-skip that records condition_not_met', () => {
  it('a job that calls ctx.skip completes with status=completed and metadata.conditionNotMet', async () => {
    const mod = defineFakeEvent('outcome.resolving', always, [
      job((ctx: JobContext) => { const { input } = ctx; if (!(input as { driverId?: string }).driverId) return ctx.skip('no driver on this outcome'); return { notified: true }; }, { name: 'notifyDriver' }),
    ]);
    const result = await createEventKit(fakeSource()).registerEvents([mod]).handle('go');

    const j = result.events[0]!.jobs[0]!;
    expect(j.status).toBe('completed');                 // it ran; it chose to do nothing
    expect(j.status).not.toBe('skipped');               // NOT the reserved series status
    expect(j.metadata['conditionNotMet']).toEqual({ reason: 'no driver on this outcome' });
    expect(j.output).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it('a normal completion carries no conditionNotMet, and skip does not retry', async () => {
    let attempts = 0;
    const mod = defineFakeEvent('e', always, [
      job(() => { return { ok: true }; }, { name: 'didWork' }),
      job((ctx: JobContext) => { attempts++; return ctx.skip('nothing to do'); }, { name: 'skipper', retries: 3 }),
    ]);
    const result = await createEventKit(fakeSource()).registerEvents([mod]).handle('go');

    const didWork = result.events[0]!.jobs.find(j => j.jobName === 'didWork')!;
    const skipper = result.events[0]!.jobs.find(j => j.jobName === 'skipper')!;
    expect(didWork.metadata['conditionNotMet']).toBeUndefined();
    expect(skipper.metadata['conditionNotMet']).toEqual({ reason: 'nothing to do' });
    expect(attempts).toBe(1); // a skip is not a failure — it never retries despite retries:3
  });
});
