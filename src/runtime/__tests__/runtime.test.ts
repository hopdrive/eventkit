import { describe, it, expect } from 'vitest';
import { createEventKit, run, job, type EventKitPlugin, type JobContext } from '../../index.js';
import { fakeSource, defineFakeEvent } from '../../testing/index.js';

// A detector that always fires, and a handler that runs the given jobs.
const always = () => true;

describe('no-plugin kit: detect + run jobs in-memory', () => {
  it('detects a registered event and runs its jobs end to end', async () => {
    const ran: string[] = [];
    const mod = defineFakeEvent(
      'thing.happened',
      ctx => ctx.payload === 'go',
      (event, _ctx) =>
        run(event, [
          job(() => {
            ran.push('a');
            return { ok: true };
          }, { name: 'jobA' }),
          job(() => {
            ran.push('b');
            return 42;
          }, { name: 'jobB' }),
        ]),
    );

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
    const mod = defineFakeEvent('thing.happened', () => false, (event, _ctx) => run(event, []));
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    const result = await kit.handle('nope');
    expect(result.events).toHaveLength(0);
  });
});

describe('ADR-018: run() rejects non-job entries', () => {
  const makeKit = (jobs: unknown[]) => {
    const mod = defineFakeEvent('e', always, (event, _ctx) => run(event, jobs as never));
    return createEventKit(fakeSource()).registerEvents([mod]);
  };

  it('throws on a falsy entry (cond && job())', async () => {
    // The handler's run() throw surfaces as the handler's error; the invocation
    // still completes, but the event records zero jobs and an error was reported.
    const errors: string[] = [];
    const capture: EventKitPlugin = { name: 'capture', onError: ctx => void errors.push(ctx.error.message) };
    const mod = defineFakeEvent('e', always, (event, _ctx) => run(event, [false as never]));
    const kit = createEventKit(fakeSource()).use(capture).registerEvents([mod]);
    await kit.handle('x');
    expect(errors.some(m => /non-job entry/.test(m))).toBe(true);
  });

  it('throws synchronously when run() is awaited directly with a bad list', async () => {
    const errors: string[] = [];
    const capture: EventKitPlugin = { name: 'capture', onError: ctx => void errors.push(ctx.error.message) };
    const mod = defineFakeEvent('e', always, (event, _ctx) => run(event, [null as never, undefined as never]));
    const kit = createEventKit(fakeSource()).use(capture).registerEvents([mod]);
    await kit.handle('x');
    expect(errors.some(m => /non-job entry at index 0/.test(m))).toBe(true);
    void makeKit;
  });
});

describe('ADR-020: augmentJobContext merge order + ambient trackingToken', () => {
  it('merges plugin input baselines UNDER handler input (handler keys win)', async () => {
    const baseliner: EventKitPlugin = {
      name: 'baseliner',
      augmentJobContext: () => ({ input: { a: 'plugin', b: 'plugin' } }),
    };
    let seen: Record<string, unknown> | undefined;
    const mod = defineFakeEvent('e', always, (event, _ctx) =>
      run(event, [
        job(
          (ctx: JobContext) => {
            seen = ctx.input as Record<string, unknown>;
          },
          { input: { b: 'handler', c: 'handler' } },
        ),
      ]),
    );

    const kit = createEventKit(fakeSource()).use(baseliner).registerEvents([mod]);
    await kit.handle('x');
    expect(seen).toEqual({ a: 'plugin', b: 'handler', c: 'handler' });
  });

  it('exposes a deterministic default trackingToken, overridable by a plugin', async () => {
    let token = '';
    const mod = defineFakeEvent('e', always, (event, _ctx) =>
      run(event, [job((ctx: JobContext) => void (token = ctx.trackingToken))]),
    );
    const kit = createEventKit(fakeSource({ correlationId: 'corr-1' })).registerEvents([mod]);
    await kit.handle('x');
    expect(token).toBe('fake.corr-1.' + token.split('.')[2]);
    expect(token.startsWith('fake.corr-1.')).toBe(true);

    const overrider: EventKitPlugin = {
      name: 'overrider',
      augmentJobContext: () => ({ ambient: { trackingToken: 'custom-token' } }),
    };
    let token2 = '';
    const mod2 = defineFakeEvent('e', always, (event, _ctx) =>
      run(event, [job((ctx: JobContext) => void (token2 = ctx.trackingToken))]),
    );
    const kit2 = createEventKit(fakeSource()).use(overrider).registerEvents([mod2]);
    await kit2.handle('x');
    expect(token2).toBe('custom-token');
  });
});

describe('ADR-014: run() defaults parallel + continueOnFailure', () => {
  it('a failing job does not block the others (parallel default)', async () => {
    const mod = defineFakeEvent('e', always, (event, _ctx) =>
      run(event, [
        job(() => {
          throw new Error('boom');
        }, { name: 'bad' }),
        job(() => 'ok', { name: 'good' }),
      ]),
    );
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    const result = await kit.handle('x');
    const jobs = result.events[0]!.jobs;
    expect(jobs.find(j => j.jobName === 'bad')!.status).toBe('failed');
    expect(jobs.find(j => j.jobName === 'bad')!.error?.message).toBe('boom');
    expect(jobs.find(j => j.jobName === 'good')!.status).toBe('completed');
    expect(result.ok).toBe(false);
  });

  it('series + continueOnFailure:false stops and marks the rest skipped', async () => {
    const ran: string[] = [];
    const mod = defineFakeEvent('e', always, (event, _ctx) =>
      run(
        event,
        [
          job(() => void ran.push('1'), { name: 'one' }),
          job(() => {
            ran.push('2');
            throw new Error('stop here');
          }, { name: 'two' }),
          job(() => void ran.push('3'), { name: 'three' }),
        ],
        { mode: 'series', continueOnFailure: false },
      ),
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
    const mod = defineFakeEvent('e', always, (event, _ctx) =>
      run(event, [job(() => new Promise(() => {}), { name: 'slow', timeoutMs: 25 })]),
    );
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    const result = await kit.handle('x');
    expect(result.events[0]!.jobs[0]!.status).toBe('timed_out');
  });

  it('cancels in-flight jobs when the serverless budget expires', async () => {
    const mod = defineFakeEvent('e', always, (event, _ctx) =>
      run(event, [job(() => new Promise(resolve => setTimeout(resolve, 1000)), { name: 'longrunner' })]),
    );
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    // budget = 250 - 200 (flush margin) = 50ms before abort fires
    const result = await kit.handle('x', { getRemainingTimeMs: () => 250 });
    expect(result.events[0]!.jobs[0]!.status).toBe('cancelled');
    expect(result.timedOut).toBe(true);
  });

  it('retries a failing job up to retries+1 attempts', async () => {
    let attempts = 0;
    const mod = defineFakeEvent('e', always, (event, _ctx) =>
      run(event, [
        job(
          () => {
            attempts += 1;
            if (attempts < 3) throw new Error('flaky');
            return 'finally';
          },
          { name: 'flaky', retries: 2 },
        ),
      ]),
    );
    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    const result = await kit.handle('x');
    expect(attempts).toBe(3);
    expect(result.events[0]!.jobs[0]!.status).toBe('completed');
    expect(result.events[0]!.jobs[0]!.attempt).toBe(3);
  });
});

describe('plugin lifecycle + capability validation', () => {
  it('fans out notifications in registration order', async () => {
    const calls: string[] = [];
    const p1: EventKitPlugin = { name: 'p1', onInvocationStart: () => void calls.push('p1') };
    const p2: EventKitPlugin = { name: 'p2', onInvocationStart: () => void calls.push('p2') };
    const mod = defineFakeEvent('e', always, (event, _ctx) => run(event, []));
    const kit = createEventKit(fakeSource()).use(p1).use(p2).registerEvents([mod]);
    await kit.handle('x');
    // source is registration[0]; the two plugins fire in order after it
    expect(calls).toEqual(['p1', 'p2']);
  });

  it('throws when a plugin requires an unsatisfied capability', async () => {
    const needsHasura: EventKitPlugin = { name: 'needs-hasura', requires: ['source:hasura'] };
    const mod = defineFakeEvent('e', always, (event, _ctx) => run(event, []));
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
