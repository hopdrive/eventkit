import { describe, it, expect } from 'vitest';
import { createEventKit, defineEvent, job } from '../../index.js';
import type { EventKitPlugin, InvocationContext } from '../../core/index.js';
import { hasuraEvent } from '../source-hasura.js';
import type { HasuraEventPayload, HasuraOperation } from '../hasura-shared/types.js';
import { loopGuard } from '../loop-guard/index.js';
import { originDecoder, type OriginDecoder } from '../origin-decoder/index.js';

type Row = Record<string, unknown>;

// A Hasura DB-event payload. `traceId` becomes event.trace_context.trace_id (the client's
// x-b3-traceid); `updatedBy` seeds the row write field loop-guard reads for chaining.
function payload(
  newRow: Row | null,
  opts: { traceId?: string; updatedBy?: string; op?: HasuraOperation } = {},
): HasuraEventPayload {
  const row = opts.updatedBy && newRow ? { ...newRow, updated_by: opts.updatedBy } : newRow;
  return {
    id: 'evt-1',
    created_at: '2026-06-28T12:00:00.000Z',
    trigger: { name: 'appointments' },
    table: { schema: 'public', name: 'appointments' },
    event: {
      op: opts.op ?? 'INSERT',
      data: { old: null, new: row },
      session_variables: { 'x-hasura-role': 'admin' },
      ...(opts.traceId ? { trace_context: { trace_id: opts.traceId } } : {}),
    },
    delivery_info: { max_retries: 0, current_retry: 0 },
  } as HasuraEventPayload;
}

const alwaysDetects = () =>
  defineEvent({
    name: 'row.touched',
    detector: hasuraEvent.detector(() => true),
    jobs: [job(() => ({}))],
  });

// Captures the final request.meta the invocation ran with (what observability serializes
// as context_data) plus the resolved correlation id. onInvocationStart runs after
// configureInvocation, so it sees the origin object originDecoder contributed.
function capture(sink: { meta?: Record<string, unknown>; correlationId?: string }): () => EventKitPlugin {
  return () => ({
    name: 'capture',
    onInvocationStart(ctx: InvocationContext) {
      sink.meta = ctx.request.meta;
      sink.correlationId = ctx.correlationId;
    },
  });
}

// A consumer-owned decoder: an append-only registry keyed by the FULL trace id.
const REGISTRY: Record<string, Record<string, unknown>> = {
  'act-move-create': { action: 'move.create', site: 'dealer-portal', purpose: 'dealer creates a move' },
};
const registryDecode: OriginDecoder = traceId => REGISTRY[traceId] ?? null;

describe('originDecoder plugin', () => {
  it('throws at registration when no decode function is supplied', () => {
    // @ts-expect-error decode is required
    expect(() => originDecoder({})).toThrow(/requires a `decode` function/);
    // @ts-expect-error decode must be a function
    expect(() => originDecoder({ decode: 'nope' })).toThrow(/requires a `decode` function/);
  });

  it('injects the decoded origin verbatim when the trace id is recognized', async () => {
    const sink: { meta?: Record<string, unknown> } = {};
    const kit = createEventKit(hasuraEvent())
      .use(originDecoder, { decode: registryDecode })
      .use(capture(sink))
      .registerEvents([alwaysDetects()]);

    await kit.handle(payload({ id: 1 }, { traceId: 'act-move-create' }));

    expect(sink.meta?.origin).toEqual({
      action: 'move.create',
      site: 'dealer-portal',
      purpose: 'dealer creates a move',
    });
  });

  it('no-ops when the decoder does not recognize the trace id', async () => {
    const sink: { meta?: Record<string, unknown> } = {};
    const kit = createEventKit(hasuraEvent())
      .use(originDecoder, { decode: registryDecode })
      .use(capture(sink))
      .registerEvents([alwaysDetects()]);

    await kit.handle(payload({ id: 1 }, { traceId: 'some-unregistered-id' }));

    expect(sink.meta?.origin).toBeUndefined();
  });

  it('no-ops when there is no inbound trace id', async () => {
    const sink: { meta?: Record<string, unknown> } = {};
    const kit = createEventKit(hasuraEvent())
      .use(originDecoder, { decode: registryDecode })
      .use(capture(sink))
      .registerEvents([alwaysDetects()]);

    await kit.handle(payload({ id: 1 })); // no trace_context

    expect(sink.meta?.origin).toBeUndefined();
  });

  it('injects whatever shape the decoder returns (a packed-format decoder)', async () => {
    // A different scheme: a decoder that unpacks a composite id into its own fields.
    const decode: OriginDecoder = id =>
      id.startsWith('v1.') ? { scheme: 'v1', app: id.slice(3), env: 'prod' } : null;
    const sink: { meta?: Record<string, unknown> } = {};
    const kit = createEventKit(hasuraEvent())
      .use(originDecoder, { decode })
      .use(capture(sink))
      .registerEvents([alwaysDetects()]);

    await kit.handle(payload({ id: 1 }, { traceId: 'v1.driver-app' }));

    expect(sink.meta?.origin).toEqual({ scheme: 'v1', app: 'driver-app', env: 'prod' });
  });

  it('reads the trace id, not the correlation id: correlation stays fresh, origin still decodes', async () => {
    const sink: { meta?: Record<string, unknown>; correlationId?: string } = {};
    const kit = createEventKit(hasuraEvent())
      .use(originDecoder, { decode: registryDecode })
      .use(capture(sink))
      .registerEvents([alwaysDetects()]);

    await kit.handle(payload({ id: 1 }, { traceId: 'act-move-create' }));

    // Correlation is a fresh minted id, NOT the client's trace id.
    expect(sink.correlationId).not.toBe('act-move-create');
    // But the origin still decoded from the conveyed trace id.
    expect(sink.meta?.origin).toMatchObject({ action: 'move.create' });
  });

  it('no-ops on a downstream hop while loop-guard still recovers the chain correlation', async () => {
    // A hop: the row carries an inbound tracking token (loop-guard chains the root
    // correlation), and the trace id is a Hasura-minted span the decoder does not know.
    const rootCorr = '11111111111111111111111111111111';
    const codecCfg = { separator: '|', validateCorrelationId: true };
    const sink: { meta?: Record<string, unknown>; correlationId?: string } = {};
    const kit = createEventKit(hasuraEvent())
      .use(loopGuard, { codec: codecCfg })
      .use(originDecoder, { decode: registryDecode })
      .use(capture(sink))
      .registerEvents([alwaysDetects()]);

    await kit.handle(
      payload({ id: 1 }, { op: 'UPDATE', traceId: 'hasura-minted-span', updatedBy: `hopdrive|${rootCorr}|job-1` }),
    );

    expect(sink.correlationId).toBe(rootCorr); // loop-guard recovered the chain id
    expect(sink.meta?.origin).toBeUndefined(); // decoder no-ops on the hop's trace id
  });
});
