import { describe, it, expect } from 'vitest';
import { createEventKit, defineEvent, job, ActionError, type JobContext } from '../../index.js';
import { netlifyPlatform } from '../platform-netlify/index.js';
import { buildDetectorContextFor, buildHandlerContextFor } from '../../testing/index.js';
import { hasuraAction } from '../source-hasura.js';
import type { HasuraActionContext, HasuraActionHandlerContext } from '../hasura-shared/types.js';

const loginPayload = (input: Record<string, unknown> = { email: 'a@b.co', password: 'pw' }) => ({
  action: { name: 'login' },
  input,
  session_variables: { 'x-hasura-role': 'user', 'x-hasura-user-id': '42', 'x-hasura-user-email': 'a@b.co' },
  request_query: 'mutation { login(email: "a@b.co") { accessToken } }',
});

// Classic Netlify/Lambda event wrapping the action JSON body (netlifyPlatform style).
const actionEvent = (payload: unknown) => ({ httpMethod: 'POST', body: JSON.stringify(payload) });

describe('hasuraAction source — payload parse + session extraction (§7.2)', () => {
  it('exposes actionName, input, sessionVariables (role/userId/email), requestQuery', () => {
    const ctx = buildDetectorContextFor<HasuraActionContext>(hasuraAction, loginPayload());
    expect(ctx.actionName).toBe('login');
    expect(ctx.input).toEqual({ email: 'a@b.co', password: 'pw' });
    expect(ctx.sessionVariables).toEqual({ role: 'user', userId: '42', email: 'a@b.co' });
    expect(ctx.requestQuery).toMatch(/^mutation/);
    // sourceType is the request/response class
    expect(ctx.sourceType).toBe('action');
  });

  it('handler context carries the same action data; missing session → nulls', () => {
    const hctx = buildHandlerContextFor<HasuraActionHandlerContext>(hasuraAction, { action: { name: 'ping' }, input: {} });
    expect(hctx.actionName).toBe('ping');
    expect(hctx.sessionVariables).toEqual({ role: null, userId: null, email: null });
    expect(hctx.requestQuery).toBeUndefined();
  });
});

describe("hasuraAction over the generic netlifyPlatform — the action's work is a JOB; kit.handler({ after }) shapes the reply", () => {
  // The action's business logic runs as a durable, observable JOB; the invocation
  // layer composes the wire reply from the typed rollup (ADR-026, re-amended).
  const loginModule = () =>
    hasuraAction.defineEvent({
      name: 'login',
      detector: ctx => ctx.actionName === 'login',
      jobs: [
        job(
          (c: JobContext<{ email?: string }>) => ({ accessToken: 'tok-' + (c.input.email ?? '?'), userId: 42 }),
          { name: 'computeLogin', input: ctx => ({ email: ((ctx as { input?: { email?: string } }).input ?? {}).email }) },
        ),
      ],
    });

  it("the job's output becomes the 2xx body via after { fromResults }", async () => {
    const handler = createEventKit(hasuraAction)
      .use(netlifyPlatform)
      .registerEvents([loginModule()])
      .handler({
        after: { fromResults: result => result.events[0]?.jobs[0]?.output ?? null },
      });
    const res = (await handler(actionEvent(loginPayload()), { functionName: 'app-login' })) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ accessToken: 'tok-a@b.co', userId: 42 });
  });

  it('a thrown ActionError from after → 4xx + { message, extensions: { code } } (Hasura contract)', async () => {
    const handler = createEventKit(hasuraAction)
      .use(netlifyPlatform)
      .registerEvents([loginModule()])
      .handler({
        after: {
          fromResults: result => {
            // arbitrary business logic over the typed rollup — here: any failed job → 4xx
            if (!result.ok || result.events.length === 0) throw new ActionError('invalid credentials', 'INVALID_CREDENTIALS');
            throw new ActionError('invalid credentials', 'INVALID_CREDENTIALS'); // this contract test always rejects
          },
        },
      });
    const res = (await handler(actionEvent(loginPayload()), {})) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ message: 'invalid credentials', extensions: { code: 'INVALID_CREDENTIALS' } });
  });

  it('no after declared → 200 standard ack, jobs still run', async () => {
    let ran = false;
    const handler = createEventKit(hasuraAction)
      .use(netlifyPlatform)
      .registerEvents([
        hasuraAction.defineEvent({
          name: 'ping',
          detector: ctx => ctx.actionName === 'ping',
          jobs: [job(() => void (ran = true))],
        }),
      ])
      .handler();
    const res = (await handler(actionEvent({ action: { name: 'ping' }, input: {} }), {})) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true); // the generic fire-and-forget ack
    expect(ran).toBe(true);
  });
});
