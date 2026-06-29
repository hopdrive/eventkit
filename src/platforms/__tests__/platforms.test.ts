import { describe, it, expect, vi, afterEach } from 'vitest';
import { createEventKit, job, asEventName, type EventModule } from '../../index.js';
import { hasuraEvent } from '../../sources/hasura/index.js';
import { lambdaPlatform, netlifyPlatform, netlifyBackgroundPlatform, netlifyV2Platform } from '../index.js';

// A Netlify/Lambda classic event wrapping a Hasura DB-event payload as a JSON body.
const hasuraHttpEvent = (newRow: Record<string, unknown>) => ({
  httpMethod: 'POST',
  path: '/db-appointments',
  body: JSON.stringify({
    id: 'evt',
    created_at: '2026-06-28T12:00:00.000Z',
    table: { schema: 'public', name: 'appointments' },
    trigger: { name: 't' },
    event: { op: 'INSERT', data: { old: null, new: newRow }, session_variables: { 'x-hasura-role': 'admin' } },
  }),
});

const apptReady = (): EventModule => {
  const detector = hasuraEvent.detector(ctx => ctx.operation === 'INSERT' && ctx.newRow?.status === 'ready');
  return { name: asEventName('appointment.ready'), detector, jobs: [job(() => ({ sent: true }), { name: 'notify' })] } as EventModule;
};

describe('netlifyPlatform (classic) via kit.handler()', () => {
  it('runs a db-* function with no hand-written getRemainingTimeInMillis and returns {statusCode, body}', async () => {
    const kit = createEventKit(hasuraEvent).use(netlifyPlatform).registerEvents([apptReady()]);
    const handler = kit.handler();
    const context = { getRemainingTimeInMillis: () => 8000, functionName: 'db-appointments' };
    const res = (await handler(hasuraHttpEvent({ id: 1, status: 'ready' }), context)) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.events).toEqual([{ name: 'appointment.ready', detected: true, jobs: 1 }]);
  });

  it('wires the native countdown into the time budget (cancels when the budget is short)', async () => {
    const slow = (): EventModule => ({
      name: asEventName('e'),
      detector: hasuraEvent.detector(() => true),
      jobs: [job(() => new Promise(r => setTimeout(r, 1000)), { name: 'longrunner' })],
    }) as EventModule;
    const kit = createEventKit(hasuraEvent).use(netlifyPlatform).registerEvents([slow()]);
    const handler = kit.handler();
    // budget = 250 - 200 margin = ~50ms before abort
    const res = (await handler(hasuraHttpEvent({ id: 1 }), { getRemainingTimeInMillis: () => 250 })) as { body: string };
    const body = JSON.parse(res.body);
    expect(body.timedOut).toBe(true);
  });
});

describe('lambdaPlatform', () => {
  it('extracts the JSON body, wires the budget, and formats {statusCode, body}', async () => {
    const p = lambdaPlatform();
    expect(p.provides).toContain('platform');
    expect(p.extractPayload!({ body: JSON.stringify({ hello: 'world' }) })).toEqual({ hello: 'world' });
    const req = p.buildRequest!({}, { getRemainingTimeInMillis: () => 1234, functionName: 'fn' });
    expect(req.getRemainingTimeMs!()).toBe(1234);
    expect(req.sourceFunction).toBe('fn');
    const res = p.formatResponse!({ ok: true, invocationId: 'i' as never, events: [], durationMs: 1 }) as { statusCode: number };
    expect(res.statusCode).toBe(200);
  });

  it('formats a fatal (framework) error as 500 — the only path that triggers a retry', () => {
    const p = lambdaPlatform();
    const res = p.formatResponse!({
      ok: false,
      invocationId: 'i' as never,
      events: [],
      durationMs: 1,
      error: { name: 'Error', message: 'normalize blew up' },
    }) as { statusCode: number };
    expect(res.statusCode).toBe(500);
  });
});

describe('netlifyBackgroundPlatform', () => {
  it('returns 202 and uses a long computed budget when no native countdown', () => {
    const p = netlifyBackgroundPlatform({ maxExecutionMs: 900_000 });
    const req = p.buildRequest!({}, undefined);
    expect(req.getRemainingTimeMs!()).toBeGreaterThan(800_000);
    const res = p.formatResponse!({ ok: true, invocationId: 'i' as never, events: [], durationMs: 1 }) as { statusCode: number };
    expect(res.statusCode).toBe(202);
  });
});

describe('netlifyV2Platform (Web Request/Response, bucket B)', () => {
  it('awaits request.json(), computes a deadline, and returns a Response', async () => {
    const p = netlifyV2Platform({ maxExecutionMs: 10_000 });
    const request = { json: async () => ({ hello: 'v2' }) };
    expect(await p.extractPayload!(request)).toEqual({ hello: 'v2' });
    const req = p.buildRequest!(request);
    const remaining = req.getRemainingTimeMs!();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(10_000);
    const res = p.formatResponse!({ ok: true, invocationId: 'i' as never, events: [], durationMs: 1 });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(200);
  });

  it('drives a full invocation through kit.handler()', async () => {
    const kit = createEventKit(hasuraEvent).use(netlifyV2Platform).registerEvents([apptReady()]);
    const handler = kit.handler();
    const request = {
      json: async () => ({
        id: 'evt', created_at: '2026-06-28T12:00:00Z', table: { schema: 'public', name: 'appointments' },
        trigger: { name: 't' }, event: { op: 'INSERT', data: { old: null, new: { id: 1, status: 'ready' } }, session_variables: {} },
      }),
    };
    const res = (await handler(request, {})) as Response;
    expect(res.status).toBe(200);
    expect((await res.json() as { ok: boolean }).ok).toBe(true);
  });
});

describe('handler({ before }) pre-handle rejection is shaped by the platform (not hand-coded)', () => {
  const reject = () => ({ status: 401, body: 'Unauthorized!' });

  it('classic netlifyPlatform shapes a rejection as { statusCode, body }', async () => {
    const kit = createEventKit(hasuraEvent).use(netlifyPlatform).registerEvents([apptReady()]);
    const handler = kit.handler({ before: reject });
    const res = (await handler(hasuraHttpEvent({ id: 1, status: 'ready' }), {})) as { statusCode: number; body: string };
    expect(res).toEqual({ statusCode: 401, body: 'Unauthorized!' });
  });

  it('netlifyV2Platform shapes the SAME rejection as a Web Response (not a malformed {statusCode})', async () => {
    const kit = createEventKit(hasuraEvent).use(netlifyV2Platform).registerEvents([apptReady()]);
    const handler = kit.handler({ before: reject });
    const request = { json: async () => ({}) };
    const res = (await handler(request, {})) as Response;
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('Unauthorized!');
  });

  it('proceeds to the invocation when before returns void', async () => {
    const kit = createEventKit(hasuraEvent).use(netlifyPlatform).registerEvents([apptReady()]);
    const handler = kit.handler({ before: () => undefined });
    const res = (await handler(hasuraHttpEvent({ id: 1, status: 'ready' }), { getRemainingTimeInMillis: () => 5000 })) as { statusCode: number };
    expect(res.statusCode).toBe(200);
  });
});

describe('detect-and-warn', () => {
  afterEach(() => {
    delete process.env.NETLIFY;
    vi.restoreAllMocks();
  });

  it('warns once at init when a deadline-capable platform is detected but no adapter is registered', async () => {
    process.env.NETLIFY = 'true';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kit = createEventKit(hasuraEvent).registerEvents([apptReady()]);
    // No platform registered → handle() takes the raw Hasura payload directly.
    await kit.handle({
      id: 'e', created_at: '2026-06-28T12:00:00Z', table: { schema: 'public', name: 'appointments' },
      trigger: { name: 't' }, event: { op: 'INSERT', data: { old: null, new: { id: 1, status: 'ready' } }, session_variables: {} },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/deadline-capable platform \(Netlify\).*no platform adapter/);
  });

  it('does not warn when a platform adapter is registered', async () => {
    process.env.NETLIFY = 'true';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kit = createEventKit(hasuraEvent).use(netlifyPlatform).registerEvents([apptReady()]);
    await kit.handle(hasuraHttpEvent({ id: 1, status: 'ready' }), { getRemainingTimeInMillis: () => 5000 });
    expect(warn).not.toHaveBeenCalled();
  });
});
