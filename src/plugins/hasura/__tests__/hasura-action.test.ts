import { describe, it, expect } from 'vitest';
import { createEventKit, defineEvent, job, ActionError, type JobContext } from '../../../index.js';
import { netlifyPlatform } from '../../netlify-platform/index.js';
import { buildDetectorContextFor, buildHandlerContextFor } from '../../../testing/index.js';
import { hasuraAction } from '../index.js';
import type { HasuraActionContext, HasuraActionHandlerContext } from '../types.js';

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

describe('hasuraAction over the generic netlifyPlatform — resolve → 2xx; ActionError → 4xx {message,extensions}', () => {
  const buildLoginKit = (resolve: HasuraActionSourceResolve) =>
    createEventKit(hasuraAction)
      .use(netlifyPlatform)
      .registerEvents([
        defineEvent({
          name: 'login',
          detector: hasuraAction.detector((ctx: HasuraActionContext) => ctx.actionName === 'login'),
          resolve,
        }),
      ]);

  it("resolve's return becomes the 2xx body (the action's declared output type)", async () => {
    const handler = buildLoginKit(
      hasuraAction.resolve((ctx: HasuraActionHandlerContext & { prepared: Record<string, unknown> }) => ({
        accessToken: 'tok-' + (ctx.input as { email: string }).email,
        userId: 42,
      })),
    ).handler();
    const res = (await handler(actionEvent(loginPayload()), { functionName: 'app-login' })) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ accessToken: 'tok-a@b.co', userId: 42 });
  });

  it('a thrown ActionError → 4xx + { message, extensions: { code } } (Hasura contract)', async () => {
    const handler = buildLoginKit(
      hasuraAction.resolve(() => {
        throw new ActionError('invalid credentials', 'INVALID_CREDENTIALS');
      }),
    ).handler();
    const res = (await handler(actionEvent(loginPayload()), {})) as { statusCode: number; body: string };

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ message: 'invalid credentials', extensions: { code: 'INVALID_CREDENTIALS' } });
  });

  it('a no-resolve (fire-and-forget) action → 200 ack, jobs still run', async () => {
    let ran = false;
    const handler = createEventKit(hasuraAction)
      .use(netlifyPlatform)
      .registerEvents([
        defineEvent({
          name: 'ping',
          detector: hasuraAction.detector((ctx: HasuraActionContext) => ctx.actionName === 'ping'),
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

describe('resolve + jobs run alongside (sibling-ignorant)', () => {
  it('the response comes from resolve while a fire-and-forget job also runs', async () => {
    let jobRan = false;
    const kit = createEventKit(hasuraAction).registerEvents([
      defineEvent({
        name: 'login',
        detector: hasuraAction.detector((ctx: HasuraActionContext) => ctx.actionName === 'login'),
        prepare: hasuraAction.prepare(() => ({ sdk: { token: () => 'T' } })),
        resolve: hasuraAction.resolve(ctx => ({ accessToken: (ctx.prepared as { sdk: { token: () => string } }).sdk.token() })),
        jobs: [job((c: JobContext) => { jobRan = true; void c; })],
      }),
    ]);
    const result = await kit.handle(loginPayload());

    expect(result.resolved?.hasResolved).toBe(true);
    expect(result.resolved?.output).toEqual({ accessToken: 'T' }); // resolve used prepare's sdk
    expect(jobRan).toBe(true); // the side-effect job ran alongside
    expect(result.events[0]!.jobs[0]!.status).toBe('completed');
    expect(result.ok).toBe(true);
  });
});

type HasuraActionSourceResolve = ReturnType<typeof hasuraAction.resolve>;
