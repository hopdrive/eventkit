// =============================================================================
// @hopdrive/eventkit/sources/webhook
// =============================================================================
// Inbound vendor webhooks (§7.1) — Stripe, Twilio, Dealerware, and the reverse-
// integration repos. `sourceType: 'webhook'`. Configured per vendor:
//
//   webhook({ vendor, verify, eventTypeHeader })
//
// The adapter VERIFIES the signature (via the injected `verify`) BEFORE building the
// envelope and surfaces the result as `ctx.signatureVerified` — it NEVER throws on a
// bad signature; the detector decides what an unverified webhook means (§7.1). It also
// reads the vendor's event-type header into `ctx.eventType` for routing. Most webhooks
// are fire-and-forget; a status-contract vendor (Stripe) adds a `resolve` that returns
// an ack or throws `ClientError(4xx)` — the platform adapter maps that to the HTTP
// status (ADR-026). Signatures (HMAC) are computed synchronously, so `verify` is sync.
//
// Headers (and, where the platform preserves it, the raw body) reach the adapter via
// `request.meta` — the HTTP platform adapters surface them there, source-agnostically.
import {
  asCorrelationId,
  asEventSourceName,
  ClientError,
  type DetectorContext,
  type DetectorFunction,
  type EventEnvelope,
  type EventKitPlugin,
  type HandlerContext,
  type JobInputContext,
  type PrepareFunction,
  type RequestContext,
  type ResolveFunction,
} from '../../core/index.js';

const randomId = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `webhook-${Date.now().toString(36)}`;

const lowerKeys = (h: Record<string, unknown>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of Object.keys(h)) {
    const v = h[k];
    if (v != null) out[k.toLowerCase()] = String(v);
  }
  return out;
};

/** What an injected `verify` receives. Signature checks are synchronous (HMAC). */
export interface WebhookVerifyArgs {
  vendor: string;
  eventType: string | undefined;
  body: unknown;
  headers: Record<string, string>;
  /** The unparsed request body, if the platform preserved it (needed for HMAC over exact bytes). */
  rawBody?: string;
}

export interface WebhookConfig {
  /** Vendor identity (e.g. `'stripe'`); becomes the source name `webhook:<vendor>`. */
  vendor: string;
  /** Header carrying the vendor's event type (e.g. `'x-twilio-event'`); case-insensitive. */
  eventTypeHeader?: string;
  /**
   * Synchronous signature check. Returns true if the signature is valid. NEVER throws
   * to the caller — a throw is caught and treated as `signatureVerified: false`. Omit
   * to skip verification (then `signatureVerified` is `true` — the consumer opted out).
   * Secrets arrive captured in this closure — the source never reads process.env.
   */
  verify?: (args: WebhookVerifyArgs) => boolean;
  /**
   * One-chokepoint rejection for forged requests (ADR-030). Default `false` — `verify`
   * only annotates `signatureVerified` and the detector decides (§7.1). Set `true` to
   * reject a failed/throwing `verify` with **401** before any module runs (no detector
   * guard needed); pass `{ status?, message? }` to customize (e.g. `403`). Requires
   * `verify`. Trade-off: a rejected request creates no Invocation record (it never became
   * an event) — keep `false` and guard in the detector if you want the attempt recorded.
   */
  rejectUnverified?: boolean | { status?: number; message?: string };
}

interface WebhookFields<TBody> {
  signatureVerified: boolean;
  vendor: string;
  eventType: string | undefined;
  body: TBody;
  headers: Record<string, string>;
}

export interface WebhookDetectorContext<TBody = unknown> extends DetectorContext<TBody>, WebhookFields<TBody> {}
export interface WebhookHandlerContext<TBody = unknown> extends HandlerContext<TBody>, WebhookFields<TBody> {}

export interface WebhookSource extends EventKitPlugin {
  sourceType: 'webhook';
  detector<TBody = unknown>(fn: (ctx: WebhookDetectorContext<TBody>) => boolean | Promise<boolean>): DetectorFunction<TBody>;
  prepare<TBody = unknown, TPrepared extends Record<string, unknown> = Record<string, unknown>>(
    fn: (ctx: WebhookHandlerContext<TBody>) => TPrepared | Promise<TPrepared>,
  ): PrepareFunction<TBody>;
  resolve<TBody = unknown, TOutput = unknown>(
    fn: (ctx: JobInputContext<TBody> & WebhookFields<TBody>) => TOutput | Promise<TOutput>,
  ): ResolveFunction<TBody>;
}

const fieldsFromMeta = <TBody>(envelope: EventEnvelope<TBody>): WebhookFields<TBody> => {
  const m = (envelope.meta ?? {}) as Record<string, unknown>;
  return {
    signatureVerified: m['webhookSignatureVerified'] === true,
    vendor: String(m['webhookVendor'] ?? ''),
    eventType: typeof m['webhookEventType'] === 'string' ? (m['webhookEventType'] as string) : undefined,
    headers: (m['webhookHeaders'] as Record<string, string>) ?? {},
    body: envelope.payload,
  };
};

/** Build a per-vendor webhook source adapter (§7.1). */
export function webhook(config: WebhookConfig): WebhookSource {
  if (!config?.vendor) throw new Error('webhook() requires a `vendor`.');
  const { vendor, eventTypeHeader, verify, rejectUnverified } = config;
  if (rejectUnverified && !verify) {
    throw new Error('webhook() `rejectUnverified` requires a `verify` function — there is nothing to verify otherwise.');
  }
  const reject = rejectUnverified
    ? {
        status: typeof rejectUnverified === 'object' && typeof rejectUnverified.status === 'number' ? rejectUnverified.status : 401,
        message:
          typeof rejectUnverified === 'object' && typeof rejectUnverified.message === 'string'
            ? rejectUnverified.message
            : `webhook signature verification failed (${vendor})`,
      }
    : undefined;
  return {
    name: 'source-webhook',
    provides: ['source', 'source:webhook'],
    sourceType: 'webhook',
    // Authoring helpers — identity wrappers carrying the vendor-typed context.
    detector(fn) {
      return fn as unknown as DetectorFunction;
    },
    prepare(fn) {
      return fn as unknown as PrepareFunction;
    },
    resolve(fn) {
      return fn as unknown as ResolveFunction;
    },
    normalize(raw: unknown, request: RequestContext): EventEnvelope {
      const reqMeta = (request.meta ?? {}) as { headers?: Record<string, unknown>; rawBody?: string };
      const headers = lowerKeys(reqMeta.headers ?? {});
      const eventType = eventTypeHeader ? headers[eventTypeHeader.toLowerCase()] : undefined;
      // Verify BEFORE building the envelope; a bad/throwing verify → not verified,
      // NEVER a thrown error (the detector decides — §7.1).
      let signatureVerified = true;
      if (verify) {
        const args: WebhookVerifyArgs = { vendor, eventType, body: raw, headers };
        if (reqMeta.rawBody !== undefined) args.rawBody = reqMeta.rawBody;
        try {
          signatureVerified = verify(args) === true;
        } catch {
          signatureVerified = false;
        }
      }
      // ADR-030: opt-in one-chokepoint rejection. A failed verify throws a ClientError in
      // the pre-dispatch phase; the runtime maps it to that wire status (not a 500) and
      // skips detection/dispatch, so no module needs a `signatureVerified` guard.
      if (!signatureVerified && reject) {
        throw new ClientError(reject.status, reject.message);
      }
      return {
        id: randomId(),
        source: asEventSourceName(`webhook:${vendor}`),
        sourceType: 'webhook',
        receivedAt: new Date(),
        correlationId: asCorrelationId(request.correlationId ?? randomId()),
        payload: raw,
        meta: {
          webhookVendor: vendor,
          webhookEventType: eventType,
          webhookSignatureVerified: signatureVerified,
          webhookHeaders: headers,
          sourceFunction: `webhook:${vendor}`,
        },
        raw,
      };
    },
    buildDetectorContext(envelope: EventEnvelope, base: DetectorContext): WebhookDetectorContext {
      return { ...base, ...fieldsFromMeta(envelope) };
    },
    buildHandlerContext(envelope: EventEnvelope, base: HandlerContext): WebhookHandlerContext {
      return { ...base, ...fieldsFromMeta(envelope) };
    },
  };
}
