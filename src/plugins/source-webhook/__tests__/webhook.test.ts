import { describe, it, expect } from 'vitest';
import { createEventKit, defineEvent, job, ClientError, type JobContext } from '../../../index.js';
import { netlifyV2Platform } from '../../platform-netlify-v2/index.js';
import { webhook, type WebhookDetectorContext, type WebhookHandlerContext } from '../index.js';

// A v2-style Web Request carrying a JSON webhook body + headers.
const v2Request = (body: unknown, headers: Record<string, string>) => ({
  json: async () => body,
  headers: new Headers(headers),
});

describe('webhook source', () => {
  it('surfaces signatureVerified (true) and the eventType from the header', async () => {
    let seen: { verified?: boolean; eventType?: string; vendor?: string } = {};
    const stripe = webhook({
      vendor: 'stripe',
      eventTypeHeader: 'stripe-event',
      verify: args => args.headers['stripe-signature'] === 'good',
    });
    const mod = defineEvent({
      name: 'stripe.invoice.paid',
      detector: stripe.detector((ctx: WebhookDetectorContext) => ctx.eventType === 'invoice.paid'),
      jobs: [
        job((c: JobContext) => {
          const h = c.envelope.meta as Record<string, unknown>;
          seen = { verified: h['webhookSignatureVerified'] as boolean, eventType: h['webhookEventType'] as string, vendor: h['webhookVendor'] as string };
        }),
      ],
    });
    const kit = createEventKit(stripe).registerEvents([mod]);
    const res = await kit.handle({ id: 'evt_1' }, { meta: { headers: { 'stripe-event': 'invoice.paid', 'stripe-signature': 'good' } } });

    expect(res.events[0]!.detected).toBe(true);
    expect(seen).toEqual({ verified: true, eventType: 'invoice.paid', vendor: 'stripe' });
  });

  it('a bad/throwing signature → signatureVerified:false, NEVER throws (detector decides)', async () => {
    let verified: boolean | undefined;
    const stripe = webhook({
      vendor: 'stripe',
      eventTypeHeader: 'stripe-event',
      verify: () => { throw new Error('signature mismatch'); },
    });
    const mod = defineEvent({
      name: 'stripe.any',
      // detector reads the verification verdict and refuses unverified webhooks
      detector: stripe.detector((ctx: WebhookDetectorContext) => { verified = ctx.signatureVerified; return ctx.signatureVerified; }),
      jobs: [job(() => {})],
    });
    const kit = createEventKit(stripe).registerEvents([mod]);
    const res = await kit.handle({ id: 'evt' }, { meta: { headers: { 'stripe-event': 'x', 'stripe-signature': 'forged' } } });

    expect(verified).toBe(false);
    expect(res.events).toHaveLength(0); // detector rejected it; no throw, no fire
    expect(res.ok).toBe(true); // never a 5xx for a bad signature
  });

  it('routes by eventType — only the matching module fires', async () => {
    const fired: string[] = [];
    const twilio = webhook({ vendor: 'twilio', eventTypeHeader: 'x-twilio-event' });
    const mk = (name: string, type: string) =>
      defineEvent({
        name,
        detector: twilio.detector((ctx: WebhookDetectorContext) => ctx.eventType === type),
        jobs: [job(() => void fired.push(name))],
      });
    const kit = createEventKit(twilio).registerEvents([mk('sms.delivered', 'delivered'), mk('sms.failed', 'failed')]);
    await kit.handle({ MessageStatus: 'delivered' }, { meta: { headers: { 'x-twilio-event': 'delivered' } } });

    expect(fired).toEqual(['sms.delivered']);
  });

  it('status-contract vendor: resolve ack → 200; a thrown ClientError → that status (paired with netlifyV2Platform)', async () => {
    const stripe = webhook({ vendor: 'stripe', eventTypeHeader: 'stripe-event', verify: () => true });
    const ackMod = defineEvent({
      name: 'stripe.ack',
      detector: stripe.detector((ctx: WebhookDetectorContext) => ctx.eventType === 'ok'),
      resolve: stripe.resolve(() => ({ received: true })),
    });
    const rejectMod = defineEvent({
      name: 'stripe.reject',
      detector: stripe.detector((ctx: WebhookDetectorContext) => ctx.eventType === 'bad'),
      resolve: stripe.resolve((_ctx: WebhookHandlerContext & { prepared: Record<string, unknown> }) => {
        throw new ClientError(400, 'unprocessable webhook');
      }),
    });
    const handler = createEventKit(stripe).use(netlifyV2Platform).registerEvents([ackMod, rejectMod]).handler();

    const ok = (await handler(v2Request({ id: 1 }, { 'stripe-event': 'ok' }))) as Response;
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: true });

    const bad = (await handler(v2Request({ id: 2 }, { 'stripe-event': 'bad' }))) as Response;
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ message: 'unprocessable webhook' });
  });
});

describe('webhook rejectUnverified (ADR-030): one-chokepoint signature rejection', () => {
  const mkKit = (ran: { fired: boolean }) => {
    const stripe = webhook({
      vendor: 'stripe',
      eventTypeHeader: 'stripe-event',
      verify: args => args.headers['stripe-signature'] === 'good',
      rejectUnverified: true,
    });
    const mod = defineEvent({
      name: 'stripe.any',
      detector: stripe.detector(() => true), // no signatureVerified guard needed
      jobs: [job(() => { ran.fired = true; }, { name: 'work' })],
    });
    return createEventKit(stripe).registerEvents([mod]);
  };

  it('a forged request is rejected with 401 before any module runs', async () => {
    const ran = { fired: false };
    const res = await mkKit(ran).handle({ id: 1 }, { meta: { headers: { 'stripe-event': 'x', 'stripe-signature': 'forged' } } });
    expect(res.resolved?.error?.status).toBe(401);
    expect(res.events).toEqual([]); // detection + dispatch skipped
    expect(ran.fired).toBe(false); // no job ran
  });

  it('a verified request passes straight through to the modules', async () => {
    const ran = { fired: false };
    const res = await mkKit(ran).handle({ id: 1 }, { meta: { headers: { 'stripe-event': 'x', 'stripe-signature': 'good' } } });
    expect(res.resolved?.error).toBeUndefined();
    expect(res.events).toHaveLength(1);
    expect(ran.fired).toBe(true);
  });

  it('the object form customizes status/message; the platform renders it (403)', async () => {
    const stripe = webhook({ vendor: 'stripe', verify: () => false, rejectUnverified: { status: 403, message: 'nope' } });
    const mod = defineEvent({ name: 'stripe.any', detector: stripe.detector(() => true), jobs: [job(() => 'x')] });
    const handler = createEventKit(stripe).use(netlifyV2Platform).registerEvents([mod]).handler();
    const res = (await handler(v2Request({ id: 1 }, {}))) as Response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'nope' });
  });

  it('rejectUnverified without verify is a construction error', () => {
    expect(() => webhook({ vendor: 'stripe', rejectUnverified: true })).toThrow(/requires a `verify`/);
  });
});
