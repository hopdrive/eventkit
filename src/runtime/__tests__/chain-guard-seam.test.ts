// =============================================================================
// Chain-guard suppress/warn seam (ADR-034 / ADR-041)
// =============================================================================
// The pre-dispatch chain-guard seam has a STRUCTURED contract (core/chain-guard):
// a plugin sets `meta[SUPPRESS_DISPATCH_KEY]` (string reason OR { reason, error })
// to hard-stop, or `meta[CHAIN_GUARD_WARNING_KEY]` ({ error }) to fire a non-fatal
// early alarm while dispatch proceeds. The RUNTIME reports through onError (phase
// 'chain-guard') on the plugin's behalf. This pins:
//   1. structured suppress with a branded LoopDetectedError → no detect/jobs; ok:true,
//      events []; onError got the branded error (name + data), phase 'chain-guard',
//      severity undefined.
//   2. legacy string reason still suppresses; onError gets a plain Error.
//   3. a suppressed invocation maps to HTTP 200 (never invite a retry of a loop).
//   4. chainGuardWarning → dispatch PROCEEDS (detector + job run); onError got the
//      branded error at severity 'warn'.
//   5. observability: a fatal halt writes error_message + status 'failed' +
//      context_data.halted; a warn-only run leaves the record clean.

import { describe, it, expect } from 'vitest';
import { createEventKit, defineEvent, job, LoopDetectedError } from '../../index.js';
import type { EventKitPlugin, EventEnvelope, ErrorContext } from '../../index.js';
import { SUPPRESS_DISPATCH_KEY, CHAIN_GUARD_WARNING_KEY } from '../../index.js';
import { netlifyV2Platform } from '../../plugins/platforms.js';
import { observability } from '../../plugins/observability/index.js';
import { fakeSource, recordingPlugin, memorySink } from '../../testing/index.js';

/** A plugin whose augmentEnvelope writes chain-guard meta keys onto the envelope. */
function metaProbe(meta: Record<string, unknown>): EventKitPlugin {
  return {
    name: 'meta-probe',
    augmentEnvelope(): Partial<EventEnvelope> {
      return { meta } as Partial<EventEnvelope>;
    },
  };
}

const loopErr = (over: Partial<{ depth: number; ceiling: number }> = {}) =>
  new LoopDetectedError('hop depth 3 reached haltAtDepth 3 — dispatch suppressed', {
    correlationId: 'corr-1',
    depth: over.depth ?? 3,
    ceiling: over.ceiling ?? 3,
    serviceId: 'svc-a',
    sourceFunction: 'db-moves',
  });

/** A module with one marker job so we can prove dispatch DID or did NOT run. */
function markerModule(ran: { value: boolean }) {
  return defineEvent({
    name: 'test.marker',
    detector: () => {
      ran.value = true;
      return true;
    },
    jobs: [job(() => 'ok', { name: 'marker' })],
  });
}

describe('chain-guard suppress seam (ADR-041)', () => {
  it('structured suppress with a LoopDetectedError halts dispatch and reports the branded error', async () => {
    const ran = { value: false };
    const recorder = recordingPlugin();
    const kit = createEventKit(fakeSource())
      .use(metaProbe({ [SUPPRESS_DISPATCH_KEY]: { reason: 'halt', error: loopErr() } }))
      .use(recorder.plugin)
      .registerEvents([markerModule(ran)]);

    const result = await kit.handle({ hello: 'world' });

    expect(ran.value).toBe(false); // detector never ran
    expect(result.ok).toBe(true);
    expect(result.events).toEqual([]);

    expect(recorder.errors.length).toBe(1);
    const ctx = recorder.errors[0] as ErrorContext;
    expect(ctx.phase).toBe('chain-guard');
    expect(ctx.severity).toBeUndefined();
    // onError receives the SERIALIZED error — assert name + the round-tripped detail.
    expect(ctx.error.name).toBe('LoopDetectedError');
    expect(ctx.error.data).toMatchObject({ correlationId: 'corr-1', depth: 3, ceiling: 3, serviceId: 'svc-a' });
  });

  it('legacy bare string reason still suppresses; onError gets a plain Error', async () => {
    const ran = { value: false };
    const recorder = recordingPlugin();
    const kit = createEventKit(fakeSource())
      .use(metaProbe({ [SUPPRESS_DISPATCH_KEY]: 'loop-guard: dispatch suppressed' }))
      .use(recorder.plugin)
      .registerEvents([markerModule(ran)]);

    const result = await kit.handle({ hello: 'world' });

    expect(ran.value).toBe(false);
    expect(result.ok).toBe(true);
    expect(result.events).toEqual([]);

    expect(recorder.errors.length).toBe(1);
    const ctx = recorder.errors[0] as ErrorContext;
    expect(ctx.phase).toBe('chain-guard');
    expect(ctx.error.name).toBe('Error');
    expect(ctx.error.message).toBe('loop-guard: dispatch suppressed');
  });

  it('a suppressed invocation maps to HTTP 200 (never invite a retry of a loop)', async () => {
    const kit = createEventKit(fakeSource())
      .use(netlifyV2Platform)
      .use(metaProbe({ [SUPPRESS_DISPATCH_KEY]: { reason: 'halt', error: loopErr() } }))
      .registerEvents([markerModule({ value: false })]);
    const handler = kit.handler();

    const res = (await handler(new Request('https://example.com/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    }), {})) as Response;

    expect(res.status).toBe(200);
  });

  it('chainGuardWarning reports the branded error at severity warn while dispatch PROCEEDS', async () => {
    const ran = { value: false };
    const recorder = recordingPlugin();
    const kit = createEventKit(fakeSource())
      .use(metaProbe({ [CHAIN_GUARD_WARNING_KEY]: { error: loopErr({ depth: 2, ceiling: 3 }) } }))
      .use(recorder.plugin)
      .registerEvents([markerModule(ran)]);

    const result = await kit.handle({ hello: 'world' });

    expect(ran.value).toBe(true); // dispatch proceeded
    expect(result.events.length).toBe(1);

    const warns = (recorder.errors as ErrorContext[]).filter(e => e.phase === 'chain-guard');
    expect(warns.length).toBe(1);
    expect(warns[0]!.severity).toBe('warn');
    expect(warns[0]!.error.name).toBe('LoopDetectedError');
    expect(warns[0]!.error.data).toMatchObject({ depth: 2, ceiling: 3 });
  });
});

describe('chain-guard observability marker (ADR-041)', () => {
  it('a fatal halt writes error_message, status failed, and context_data.halted', async () => {
    const capture = memorySink();
    const kit = createEventKit(fakeSource())
      .use(observability, { sink: capture })
      .use(metaProbe({ [SUPPRESS_DISPATCH_KEY]: { reason: 'halt', error: loopErr({ depth: 3, ceiling: 3 }) } }))
      .registerEvents([markerModule({ value: false })]);

    await kit.handle({ hello: 'world' });

    const [inv] = capture.invocations();
    expect(inv).toBeDefined();
    expect(inv!.error_message).toBeTruthy();
    expect(inv!.status).toBe('failed');
    expect((inv!.context_data as { halted?: unknown }).halted).toEqual({ depth: 3, ceiling: 3 });
  });

  it('a warn-only run leaves the invocation record clean', async () => {
    const capture = memorySink();
    const kit = createEventKit(fakeSource())
      .use(observability, { sink: capture })
      .use(metaProbe({ [CHAIN_GUARD_WARNING_KEY]: { error: loopErr({ depth: 2, ceiling: 3 }) } }))
      .registerEvents([markerModule({ value: false })]);

    await kit.handle({ hello: 'world' });

    const [inv] = capture.invocations();
    expect(inv).toBeDefined();
    expect(inv!.error_message).toBeUndefined();
    expect(inv!.status).not.toBe('failed');
    expect((inv!.context_data as { halted?: unknown } | undefined)?.halted).toBeUndefined();
  });
});
