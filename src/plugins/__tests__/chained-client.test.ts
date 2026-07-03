import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEventKit, defineEvent, job, type JobContext } from '../../index.js';
import { hasuraEvent } from '../source-hasura.js';
import { loopGuard } from '../loop-guard/index.js';
import { hasuraChainedClient, GraphqlRequestError } from '../hasura-shared/chained-client.js';
import { hasuraInsert } from '../../testing/index.js';

const ENDPOINT = 'https://hasura.test/v1/graphql';

// A captured fetch call, decoded for assertions.
interface FetchCall {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: { query: string; variables?: Record<string, unknown> };
  signal?: AbortSignal;
}

const captureFetch = (respond: (call: FetchCall) => Response | Promise<Response>) => {
  const calls: FetchCall[] = [];
  const stub = vi.fn(async (url: string, init: RequestInit) => {
    const call: FetchCall = {
      url,
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
      signal: init.signal ?? undefined,
    };
    calls.push(call);
    return respond(call);
  });
  vi.stubGlobal('fetch', stub);
  return { calls, stub };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hasuraChainedClient (ADR-039.4 — outbound token injection paved road)', () => {
  it('a job gql() posts to the endpoint with merged headers, the tracking token, and returns parsed data', async () => {
    const { calls } = captureFetch(() => jsonResponse({ data: { insert_orders: { affected_rows: 1 } } }));

    let seenToken = '';
    let result: unknown;
    const mod = defineEvent({
      name: 'order.created',
      detector: hasuraEvent.detector(() => true),
      jobs: [
        job(async (ctx: JobContext) => {
          seenToken = ctx.trackingToken;
          const { gql } = ctx.input as { gql: (q: string, v?: Record<string, unknown>) => Promise<unknown> };
          result = await gql('mutation ($id: Int!) { insert_orders(...) }', { id: 7 });
        }),
      ],
    });

    const kit = createEventKit(hasuraEvent)
      .use(loopGuard, { serviceId: 'chain-test' })
      .use(hasuraChainedClient, { endpoint: ENDPOINT, headers: { 'x-hasura-admin-secret': 'shh' } })
      .registerEvents([mod]);

    await kit.handle(hasuraInsert('orders', { id: 7 }));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(ENDPOINT);
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers['x-hasura-admin-secret']).toBe('shh');
    // The token the job saw is exactly what rode the header — read lazily at call time.
    expect(seenToken).not.toBe('');
    expect(call.headers['x-hasura-tracking-token']).toBe(seenToken);
    expect(call.body).toEqual({
      query: 'mutation ($id: Int!) { insert_orders(...) }',
      variables: { id: 7 },
    });
    expect(result).toEqual({ insert_orders: { affected_rows: 1 } });
  });

  it('a GraphQL errors array in the body rejects with the error JSON in the message', async () => {
    captureFetch(() => jsonResponse({ errors: [{ message: 'constraint violation' }] }));

    let caught: unknown;
    const mod = defineEvent({
      name: 'order.created',
      detector: hasuraEvent.detector(() => true),
      jobs: [
        job(async (ctx: JobContext) => {
          const { gql } = ctx.input as { gql: (q: string) => Promise<unknown> };
          try {
            await gql('mutation { bad }');
          } catch (err) {
            caught = err;
          }
        }),
      ],
    });

    const kit = createEventKit(hasuraEvent)
      .use(hasuraChainedClient, { endpoint: ENDPOINT })
      .registerEvents([mod]);

    await kit.handle(hasuraInsert('orders', { id: 1 }));

    expect(caught).toBeInstanceOf(GraphqlRequestError);
    expect((caught as Error).message).toContain('constraint violation');
    expect((caught as GraphqlRequestError).errors).toEqual([{ message: 'constraint violation' }]);
  });

  it('a non-2xx response rejects with "GraphQL HTTP <status>"', async () => {
    captureFetch(() => jsonResponse({}, 500));

    let caught: unknown;
    const mod = defineEvent({
      name: 'order.created',
      detector: hasuraEvent.detector(() => true),
      jobs: [
        job(async (ctx: JobContext) => {
          const { gql } = ctx.input as { gql: (q: string) => Promise<unknown> };
          try {
            await gql('mutation { x }');
          } catch (err) {
            caught = err;
          }
        }),
      ],
    });

    const kit = createEventKit(hasuraEvent)
      .use(hasuraChainedClient, { endpoint: ENDPOINT })
      .registerEvents([mod]);

    await kit.handle(hasuraInsert('orders', { id: 1 }));

    expect((caught as Error).message).toBe('GraphQL HTTP 500');
  });

  it('ADR-020 precedence: a job whose own input.gql is set wins over the plugin baseline', async () => {
    captureFetch(() => jsonResponse({ data: {} }));

    let seen: unknown;
    const mod = defineEvent({
      name: 'order.created',
      detector: hasuraEvent.detector(() => true),
      jobs: [
        job((ctx: JobContext) => void (seen = (ctx.input as { gql: unknown }).gql), {
          input: () => ({ gql: 'handler-wins' }),
        }),
      ],
    });

    const kit = createEventKit(hasuraEvent)
      .use(hasuraChainedClient, { endpoint: ENDPOINT })
      .registerEvents([mod]);

    await kit.handle(hasuraInsert('orders', { id: 1 }));

    expect(seen).toBe('handler-wins'); // handler options.input merges HIGHEST over the plugin baseline
  });

  it('missing endpoint throws synchronously at construction', () => {
    // @ts-expect-error — endpoint is required
    expect(() => hasuraChainedClient({})).toThrow(/endpoint/);
  });

  it('honors the AbortSignal on timeout: a slow request rejects', async () => {
    // A fetch stub that never resolves on its own but rejects when the signal aborts —
    // so the ONLY way this settles is the AbortController firing at timeoutMs.
    const stub = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    vi.stubGlobal('fetch', stub);

    let caught: unknown;
    const mod = defineEvent({
      name: 'order.created',
      detector: hasuraEvent.detector(() => true),
      jobs: [
        job(async (ctx: JobContext) => {
          const { gql } = ctx.input as { gql: (q: string) => Promise<unknown> };
          try {
            await gql('mutation { slow }');
          } catch (err) {
            caught = err;
          }
        }),
      ],
    });

    const kit = createEventKit(hasuraEvent)
      .use(hasuraChainedClient, { endpoint: ENDPOINT, timeoutMs: 5 })
      .registerEvents([mod]);

    await kit.handle(hasuraInsert('orders', { id: 1 }));

    expect((caught as Error).message).toBe('aborted');
  });
});
