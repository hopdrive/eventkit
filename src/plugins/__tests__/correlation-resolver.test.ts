import { describe, it, expect, vi } from 'vitest';
import { createEventKit, defineEvent, job, type JobContext } from '../../index.js';
import { webhook, type WebhookDetectorContext } from '../source-webhook/index.js';
import { loopGuard, createTokenCodec } from '../loop-guard/index.js';
import { correlationResolver } from '../correlation-resolver/index.js';

// The origin chain's id + the origin job that called the vendor (ADR-028 §4 example).
const ORIGIN_CORR = '22222222-2222-2222-2222-222222222222';
const ORIGIN_JOB = 'origin-job-1';
const codecCfg = { separator: '|', validateCorrelationId: true };
const ORIGIN_TOKEN = `hopdrive|${ORIGIN_CORR}|${ORIGIN_JOB}`;

// A vendor webhook that carries only the vendor's OWN id (`ride_id`), not our token.
const acme = () => webhook({ vendor: 'acme', eventTypeHeader: 'x-acme-event' });
const driverAssigned = (
  capture: (c: JobContext) => void,
  mod = 'vendor.ride.driver_assigned',
) =>
  defineEvent({
    name: mod,
    detector: acme().detector((ctx: WebhookDetectorContext) => ctx.eventType === 'ride.driver_assigned'),
    jobs: [job(capture)],
  });

const fire = (kit: ReturnType<typeof createEventKit>, body: unknown) =>
  kit.handle(body, { meta: { headers: { 'x-acme-event': 'ride.driver_assigned' } } });

describe('correlationResolver (ADR-028 Mechanism B — DB lookup)', () => {
  it('recovers the origin correlation + parent job from a vendor-id lookup', async () => {
    let seen: { corr?: string; token?: unknown; parent?: unknown } = {};
    const lookup = vi.fn(async (key: { externalId?: string }) =>
      key.externalId === 'V123' ? { correlationId: ORIGIN_CORR, trackingToken: ORIGIN_TOKEN } : null,
    );
    const kit = createEventKit(acme())
      .use(correlationResolver, {
        extractKey: (env: { payload?: { ride_id?: string } }) => ({ externalId: env.payload?.ride_id }),
        lookup,
        codec: codecCfg,
      })
      .registerEvents([
        driverAssigned(c => {
          seen = {
            corr: c.correlationId,
            token: c.envelope.meta['sourceTrackingToken'],
            parent: c.envelope.meta['sourceJobId'],
          };
        }),
      ]);

    const res = await fire(kit, { event: 'ride.driver_assigned', ride_id: 'V123' });

    expect(res.events[0]!.detected).toBe(true);
    expect(lookup).toHaveBeenCalledOnce();
    expect(seen.corr).toBe(ORIGIN_CORR); // recovered chain id beats the fresh webhook id
    expect(seen.token).toBe(ORIGIN_TOKEN); // recovered token lifted into meta
    expect(seen.parent).toBe(ORIGIN_JOB); // parent job parsed from the token via the codec
  });

  it('end-to-end with loop-guard: the recovered token continues the lineage into ctx.trackingToken', async () => {
    let outToken = '';
    let jobId = '';
    let corr = '';
    const kit = createEventKit(acme())
      // loop-guard first (echo-back path), resolver second (lookup fallback).
      .use(loopGuard, { codec: codecCfg })
      .use(correlationResolver, {
        extractKey: (env: { payload?: { ride_id?: string } }) => ({ externalId: env.payload?.ride_id }),
        lookup: async () => ({ correlationId: ORIGIN_CORR, trackingToken: ORIGIN_TOKEN }),
        codec: codecCfg,
      })
      .registerEvents([
        driverAssigned(c => {
          corr = c.correlationId;
          outToken = c.trackingToken;
          jobId = c.job.id;
        }),
      ]);

    await fire(kit, { event: 'ride.driver_assigned', ride_id: 'V123' });

    const codec = createTokenCodec(codecCfg);
    expect(corr).toBe(ORIGIN_CORR);
    // The outbound token this webhook's job stamps continues the SAME chain — same
    // source + correlation as the origin, swapping in this job's id. So the record it
    // writes will chain the next hasuraEvent right back to the origin request.
    expect(codec.getSource(outToken)).toBe('hopdrive');
    expect(codec.getCorrelationId(outToken)).toBe(ORIGIN_CORR);
    expect(codec.getJobExecutionId(outToken)).toBe(jobId);
  });

  it('stands down when echo-back (loop-guard) already recovered the lineage', async () => {
    // The vendor DID echo our token in the body — loop-guard recovers it synchronously,
    // so the resolver must NOT pay for a DB read (skipIfResolved default).
    let corr = '';
    const lookup = vi.fn(async () => ({ correlationId: 'should-not-be-used', trackingToken: 'x|y|z' }));
    const kit = createEventKit(acme())
      .use(loopGuard, {
        codec: codecCfg,
        // The webhook source surfaces no tokenCandidates; the escape hatch pulls the
        // echoed token out of this vendor's body so loop-guard's echo-back path wins.
        candidates: (env: { payload?: { metadata?: { eventkit_token?: string } } }) => {
          const t = env.payload?.metadata?.eventkit_token;
          return t ? [t] : [];
        },
      })
      .use(correlationResolver, {
        extractKey: (env: { payload?: { ride_id?: string } }) => ({ externalId: env.payload?.ride_id }),
        lookup,
        codec: codecCfg,
      })
      .registerEvents([driverAssigned(c => void (corr = c.correlationId))]);

    await fire(kit, { event: 'ride.driver_assigned', ride_id: 'V123', metadata: { eventkit_token: ORIGIN_TOKEN } });

    expect(lookup).not.toHaveBeenCalled(); // echo-back won; no DB read
    expect(corr).toBe(ORIGIN_CORR); // recovered by loop-guard, not the resolver
  });

  it('a miss leaves a clean fresh chain root and calls onMiss (no crash)', async () => {
    const onMiss = vi.fn();
    const lookup = vi.fn(async () => null); // vendor id not found in the mapping
    let corr = '';
    let token: unknown = 'sentinel';
    const kit = createEventKit(acme())
      .use(correlationResolver, {
        extractKey: (env: { payload?: { ride_id?: string } }) => ({ externalId: env.payload?.ride_id }),
        lookup,
        onMiss,
      })
      .registerEvents([
        driverAssigned(c => {
          corr = c.correlationId;
          token = c.envelope.meta['sourceTrackingToken'];
        }),
      ]);

    const res = await fire(kit, { event: 'ride.driver_assigned', ride_id: 'UNKNOWN' });

    expect(res.ok).toBe(true); // a miss is not an error
    expect(res.events[0]!.detected).toBe(true);
    expect(onMiss).toHaveBeenCalledOnce();
    expect(corr).not.toBe(ORIGIN_CORR); // stayed the source-minted fresh id (a new root)
    expect(token).toBeUndefined(); // no lineage stamped
  });

  it('calls onMiss without a lookup when extractKey yields nothing', async () => {
    const onMiss = vi.fn();
    const lookup = vi.fn(async () => ({ correlationId: ORIGIN_CORR }));
    const kit = createEventKit(acme())
      .use(correlationResolver, {
        extractKey: (env: { payload?: { ride_id?: string } }) => {
          const id = env.payload?.ride_id;
          return id ? { externalId: id } : undefined;
        },
        lookup,
        onMiss,
      })
      .registerEvents([driverAssigned(() => {})]);

    await fire(kit, { event: 'ride.driver_assigned' }); // no ride_id

    expect(lookup).not.toHaveBeenCalled();
    expect(onMiss).toHaveBeenCalledOnce();
  });

  it('throws if extractKey/lookup are not provided', () => {
    // @ts-expect-error — missing required config
    expect(() => correlationResolver({})).toThrow(/extractKey.*lookup/);
  });

  it('default (best-effort): a lookup throw is isolated — the event proceeds as a fresh root, ok stays true', async () => {
    // ADR-033: with the pipeline isolating pre-dispatch throws, a transient lookup
    // failure no longer drops the webhook — it proceeds un-correlated.
    let corr = '';
    const kit = createEventKit(acme())
      .use(correlationResolver, {
        extractKey: (env: { payload?: { ride_id?: string } }) => ({ externalId: env.payload?.ride_id }),
        lookup: async () => { throw Object.assign(new Error('db blip'), { status: 500 }); },
      })
      .registerEvents([driverAssigned(c => void (corr = c.correlationId))]);

    const res = await fire(kit, { event: 'ride.driver_assigned', ride_id: 'V123' });

    expect(res.ok).toBe(true);            // isolated, not a false success-with-error
    expect(res.events[0]!.detected).toBe(true);
    expect(corr).not.toBe(ORIGIN_CORR);   // stayed a fresh chain root
  });

  it("onLookupError:'reject' rethrows a lookup failure as a 5xx ClientError so the source retries", async () => {
    const kit = createEventKit(acme())
      .use(correlationResolver, {
        extractKey: (env: { payload?: { ride_id?: string } }) => ({ externalId: env.payload?.ride_id }),
        lookup: async () => { throw new Error('db down'); },
        onLookupError: 'reject',
      })
      .registerEvents([driverAssigned(() => {})]);

    const res = await fire(kit, { event: 'ride.driver_assigned', ride_id: 'V123' });

    expect(res.resolved?.error?.status).toBe(503); // maps to the wire → vendor retries
    expect(res.resolved?.error?.message).toMatch(/lookup failed/);
    expect(res.events).toHaveLength(0);            // rejected before dispatch
  });
});
