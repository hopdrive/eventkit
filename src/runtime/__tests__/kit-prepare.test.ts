import { describe, it, expect } from 'vitest';
import { createEventKit, job, type JobContext } from '../../index.js';
import { fakeSource, defineFakeEvent, type FakeDetectorContext } from '../../testing/index.js';

// A live, non-serializable ref — the canonical thing a kit-level `prepare` provides
// (in real code this is a GraphQL executor / vendor client).
const makeExecutor = () => ({ id: Symbol('exec'), query: () => 'ok' });

describe('kit-level prepare → ctx.provided (createEventKit(source, { prepare }))', () => {
  it('makes the prepared object available to detectors AND jobs (same instance)', async () => {
    const executor = makeExecutor();
    const seen: { detector?: unknown; prepare?: unknown; job?: unknown } = {};

    const mod = defineFakeEvent(
      'thing.happened',
      (ctx: FakeDetectorContext) => {
        seen.detector = ctx.provided.executor;
        return true;
      },
      [
        job((ctx: JobContext) => {
          seen.job = ctx.provided.executor;
        }, { name: 'jobA' }),
      ],
      {
        prepare: ctx => {
          seen.prepare = ctx.provided.executor;
          return {};
        },
      },
    );

    const kit = createEventKit(fakeSource(), { prepare: () => ({ executor }) }).registerEvents([mod]);
    const result = await kit.handle('go');

    expect(result.ok).toBe(true);
    // The SAME live instance reaches every phase.
    expect(seen.detector).toBe(executor);
    expect(seen.prepare).toBe(executor);
    expect(seen.job).toBe(executor);
  });

  it('runs the kit prepare exactly ONCE per invocation, regardless of module/job count', async () => {
    let calls = 0;
    const kit = createEventKit(fakeSource(), {
      prepare: () => {
        calls += 1;
        return { executor: makeExecutor() };
      },
    }).registerEvents([
      defineFakeEvent('a', () => true, [job(() => {}, { name: 'a1' }), job(() => {}, { name: 'a2' })]),
      defineFakeEvent('b', () => true, [job(() => {}, { name: 'b1' })]),
    ]);

    await kit.handle('go');
    expect(calls).toBe(1);
  });

  it('receives a KitPrepareContext (envelope + ids) and may be async', async () => {
    let ctxSeen: { hasEnvelope: boolean; source: string } | undefined;
    const kit = createEventKit(fakeSource(), {
      prepare: async ctx => {
        ctxSeen = { hasEnvelope: ctx.envelope != null, source: String(ctx.source) };
        return { executor: makeExecutor() };
      },
    }).registerEvents([defineFakeEvent('a', () => true, [job(() => {})])]);

    await kit.handle('go');
    expect(ctxSeen).toEqual({ hasEnvelope: true, source: 'fake' });
  });

  it('defaults ctx.provided to {} when no kit prepare is configured', async () => {
    let detectorProvided: unknown;
    let jobProvided: unknown;
    const mod = defineFakeEvent(
      'a',
      (ctx: FakeDetectorContext) => {
        detectorProvided = ctx.provided;
        return true;
      },
      [job((ctx: JobContext) => { jobProvided = ctx.provided; }, { name: 'j' })],
    );

    const kit = createEventKit(fakeSource()).registerEvents([mod]);
    await kit.handle('go');

    expect(detectorProvided).toEqual({});
    expect(jobProvided).toEqual({});
  });

  it('exposes ctx.provided to detectors under dryRun (detection-only)', async () => {
    const executor = makeExecutor();
    let detectorProvided: unknown;
    const mod = defineFakeEvent(
      'a',
      (ctx: FakeDetectorContext) => {
        detectorProvided = ctx.provided.executor;
        return true;
      },
      [job(() => {})],
    );

    const kit = createEventKit(fakeSource(), { prepare: () => ({ executor }) }).registerEvents([mod]);
    const dry = await kit.dryRun('go');

    expect(dry.events[0]!.detected).toBe(true);
    expect(detectorProvided).toBe(executor);
  });

  it('throws at createEventKit when prepare is not a function', () => {
    expect(() => createEventKit(fakeSource(), { prepare: 123 as never })).toThrow(/prepare.*must be a function/);
  });

  it('aborts the invocation (ok:false) and runs NO jobs when kit prepare throws', async () => {
    let jobRan = false;
    const kit = createEventKit(fakeSource(), {
      prepare: () => {
        throw new Error('boom');
      },
    }).registerEvents([defineFakeEvent('a', () => true, [job(() => { jobRan = true; }, { name: 'j' })])]);

    const result = await kit.handle('go');

    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/boom/);
    expect(result.events).toHaveLength(0);
    expect(jobRan).toBe(false);
  });
});
