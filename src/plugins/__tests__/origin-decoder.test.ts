import { describe, it, expect } from 'vitest';
import { createEventKit, defineEvent, job } from '../../index.js';
import type { EventKitPlugin, InvocationContext } from '../../core/index.js';
import { encodeOriginId } from '../../core/origin-id.js';
import { webhook, type WebhookDetectorContext } from '../source-webhook/index.js';
import { loopGuard } from '../loop-guard/index.js';
import { originDecoder } from '../origin-decoder/index.js';

const acme = () => webhook({ vendor: 'acme', eventTypeHeader: 'x-acme-event' });

const alwaysDetects = () =>
  defineEvent({
    name: 'vendor.ping',
    detector: acme().detector((ctx: WebhookDetectorContext) => ctx.eventType === 'ping'),
    jobs: [job(() => ({}))],
  });

// Captures the final request.meta the invocation ran with (what observability serializes
// as context_data). onInvocationStart runs after configureInvocation, so it sees the
// origin object originDecoder contributed.
function captureMeta(sink: { meta?: Record<string, unknown> }): () => EventKitPlugin {
  return () => ({
    name: 'capture-meta',
    onInvocationStart(ctx: InvocationContext) {
      sink.meta = ctx.request.meta;
    },
  });
}

const fire = (kit: ReturnType<typeof createEventKit>, correlationId?: string) =>
  kit.handle({ event: 'ping' }, { correlationId, meta: { headers: { 'x-acme-event': 'ping' } } });

describe('originDecoder plugin', () => {
  it('injects origin meta when the correlation id is a decodable origin id', async () => {
    const originId = encodeOriginId({ originId: 42, env: 1 });
    const sink: { meta?: Record<string, unknown> } = {};
    const kit = createEventKit(acme()).use(originDecoder).use(captureMeta(sink)).registerEvents([alwaysDetects()]);

    await fire(kit, originId);

    expect(sink.meta?.origin).toEqual({ idVersion: 1, originId: 42, env: 1, envName: 'prod' });
  });

  it('no-ops on a correlation id that is not an origin id', async () => {
    const sink: { meta?: Record<string, unknown> } = {};
    const kit = createEventKit(acme()).use(originDecoder).use(captureMeta(sink)).registerEvents([alwaysDetects()]);

    // A plain dashless-hex correlation id (a normal trace root), not an origin id.
    await fire(kit, 'abcdef0123456789abcdef0123456789');

    expect(sink.meta?.origin).toBeUndefined();
  });

  it('no-ops (no origin) when no correlation id is supplied', async () => {
    const sink: { meta?: Record<string, unknown> } = {};
    const kit = createEventKit(acme()).use(originDecoder).use(captureMeta(sink)).registerEvents([alwaysDetects()]);

    await fire(kit); // source mints a random correlation id, which is not an origin id

    expect(sink.meta?.origin).toBeUndefined();
  });

  it('resolves originName from options.originNames', async () => {
    const originId = encodeOriginId({ originId: 7, env: 4 });
    const sink: { meta?: Record<string, unknown> } = {};
    const kit = createEventKit(acme())
      .use(originDecoder, { originNames: { 7: 'driver-app', 42: 'confirmations' } })
      .use(captureMeta(sink))
      .registerEvents([alwaysDetects()]);

    await fire(kit, originId);

    expect(sink.meta?.origin).toEqual({
      idVersion: 1,
      originId: 7,
      originName: 'driver-app',
      env: 4,
      envName: 'local',
    });
  });

  it('uses a custom injected decoder', async () => {
    const sink: { meta?: Record<string, unknown> } = {};
    // A decoder that treats ANY 32-hex id as origin 9 / env 2, and nothing else.
    const decode = (id: string) =>
      /^[0-9a-f]{32}$/.test(id) ? { version: 1, originId: 9, env: 2, envName: 'test', flags: 2 } : null;
    const kit = createEventKit(acme())
      .use(originDecoder, { decode })
      .use(captureMeta(sink))
      .registerEvents([alwaysDetects()]);

    await fire(kit, 'abcdef0123456789abcdef0123456789'); // not a real origin id

    expect(sink.meta?.origin).toEqual({ idVersion: 1, originId: 9, env: 2, envName: 'test' });
  });

  it('decodes the chain-final correlation id recovered by loop-guard', async () => {
    // The origin id is the chain root. loop-guard chains the inbound token's correlation
    // id onto this invocation during augmentEnvelope; originDecoder (configureInvocation,
    // a later phase) then decodes that recovered id, whatever this hop's own id was.
    const rootOrigin = encodeOriginId({ originId: 3, env: 1 });
    const sink: { meta?: Record<string, unknown> } = {};
    const codecCfg = { separator: '|', validateCorrelationId: true };
    const inboundToken = `hopdrive|${rootOrigin}|origin-job-1`;
    const kit = createEventKit(acme())
      // The `candidates` escape hatch feeds loop-guard the inbound token directly, so it
      // lifts the root correlation id in augmentEnvelope no matter what this hop's id was.
      .use(loopGuard, { codec: codecCfg, candidates: () => [inboundToken] })
      .use(originDecoder)
      .use(captureMeta(sink))
      .registerEvents([alwaysDetects()]);

    await fire(kit); // this hop's own id is random; loop-guard chains it to rootOrigin

    expect(sink.meta?.origin).toMatchObject({ originId: 3, env: 1, envName: 'prod' });
  });
});
