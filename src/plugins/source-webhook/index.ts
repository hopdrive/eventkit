// =============================================================================
// eventkit/sources/webhook
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
  type CrashPolicy,
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
import { randomId as sharedRandomId } from '../../core/ids.js';

const randomId = (): string => sharedRandomId('webhook');

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
  /** Query params (some vendors key their token/signature on a query param, not a header). */
  query: Record<string, string>;
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
  /**
   * How an unhandled detector/`prepare` crash maps to the HTTP status (ADR-038). Defaults
   * to `'signalRetry'` for webhooks: a processing crash returns **500** so the vendor's
   * at-least-once delivery retries it (and the crash is logged loudly for Grafana/Sentry).
   * Set `'ack'` to instead return 200 on a crash (no retry) — e.g. when the vendor's
   * retries would be more harmful than a dropped event.
   */
  crashPolicy?: CrashPolicy;
}

interface WebhookFields<TBody> {
  signatureVerified: boolean;
  vendor: string;
  eventType: string | undefined;
  body: TBody;
  headers: Record<string, string>;
  query: Record<string, string>;
}

export interface WebhookDetectorContext<TBody = unknown> extends DetectorContext<TBody>, WebhookFields<TBody> {}
export interface WebhookHandlerContext<TBody = unknown> extends HandlerContext<TBody>, WebhookFields<TBody> {}

/**
 * The typed authoring helpers. Available on a configured instance AND on the bare
 * `webhook` factory value (`webhook.detector<TBody>(fn)`), so an event module can
 * type its contexts without knowing the vendor/verify config, which lives in the
 * entry file. Identity wrappers at runtime — the runtime supplies the enriched
 * context; these signatures supply the types.
 */
export interface WebhookAuthoring {
  detector<TBody = unknown>(fn: (ctx: WebhookDetectorContext<TBody>) => boolean | Promise<boolean>): DetectorFunction<TBody>;
  prepare<TBody = unknown, TPrepared extends Record<string, unknown> = Record<string, unknown>>(
    fn: (ctx: WebhookHandlerContext<TBody>) => TPrepared | Promise<TPrepared>,
  ): PrepareFunction<TBody, Record<string, unknown>, TPrepared>;
  resolve<TBody = unknown, TOutput = unknown>(
    fn: (ctx: JobInputContext<TBody> & WebhookFields<TBody>) => TOutput | Promise<TOutput>,
  ): ResolveFunction<TBody>;
}

export interface WebhookSource extends EventKitPlugin, WebhookAuthoring {
  sourceType: 'webhook';
}

// The authoring-helper implementations — identity wrappers with the WebhookAuthoring
// signatures, shared by every configured instance and the factory value itself.
function detector<TBody = unknown>(
  fn: (ctx: WebhookDetectorContext<TBody>) => boolean | Promise<boolean>,
): DetectorFunction<TBody> {
  return fn as unknown as DetectorFunction<TBody>;
}
function prepare<TBody = unknown, TPrepared extends Record<string, unknown> = Record<string, unknown>>(
  fn: (ctx: WebhookHandlerContext<TBody>) => TPrepared | Promise<TPrepared>,
): PrepareFunction<TBody, Record<string, unknown>, TPrepared> {
  return fn as unknown as PrepareFunction<TBody, Record<string, unknown>, TPrepared>;
}
function resolve<TBody = unknown, TOutput = unknown>(
  fn: (ctx: JobInputContext<TBody> & WebhookFields<TBody>) => TOutput | Promise<TOutput>,
): ResolveFunction<TBody> {
  return fn as unknown as ResolveFunction<TBody>;
}

const fieldsFromMeta = <TBody>(envelope: EventEnvelope<TBody>): WebhookFields<TBody> => {
  const m = (envelope.meta ?? {}) as Record<string, unknown>;
  return {
    signatureVerified: m['webhookSignatureVerified'] === true,
    vendor: String(m['webhookVendor'] ?? ''),
    eventType: typeof m['webhookEventType'] === 'string' ? (m['webhookEventType'] as string) : undefined,
    headers: (m['webhookHeaders'] as Record<string, string>) ?? {},
    query: (m['webhookQuery'] as Record<string, string>) ?? {},
    body: envelope.payload,
  };
};

// Generic verify presets (D33) — usable via `webhook({ verify: hmacVerify({...}) })`.
export {
  hmacVerify,
  staticHeaderToken,
  sharedSecret,
  hasuraPassphrase,
  type HmacVerifyConfig,
  type StaticHeaderTokenConfig,
  type SharedSecretConfig,
  type HasuraPassphraseConfig,
} from './presets.js';

function buildWebhook(config: WebhookConfig): WebhookSource {
  if (!config?.vendor) throw new Error('webhook() requires a `vendor`.');
  const { vendor, eventTypeHeader, verify, rejectUnverified } = config;
  // Inbound vendor webhooks are at-least-once: a processing crash should 500 so the sender
  // retries, unless the consumer opts out (ADR-038).
  const crashPolicy: CrashPolicy = config.crashPolicy ?? 'signalRetry';
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
    crashPolicy,
    // Authoring helpers — the shared identity wrappers carrying the vendor-typed context.
    detector,
    prepare,
    resolve,
    normalize(raw: unknown, request: RequestContext): EventEnvelope {
      const reqMeta = (request.meta ?? {}) as { headers?: Record<string, unknown>; query?: Record<string, unknown>; rawBody?: string };
      const headers = lowerKeys(reqMeta.headers ?? {});
      // Query keys are case-sensitive (unlike headers) — preserve case, stringify values.
      const query: Record<string, string> = {};
      for (const k of Object.keys(reqMeta.query ?? {})) {
        const v = (reqMeta.query as Record<string, unknown>)[k];
        if (v != null) query[k] = String(v);
      }
      const eventType = eventTypeHeader ? headers[eventTypeHeader.toLowerCase()] : undefined;
      // Verify BEFORE building the envelope; a bad/throwing verify → not verified,
      // NEVER a thrown error (the detector decides — §7.1).
      let signatureVerified = true;
      if (verify) {
        const args: WebhookVerifyArgs = { vendor, eventType, body: raw, headers, query };
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
          webhookQuery: query,
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

/**
 * Build a per-vendor webhook source adapter (§7.1). Unlike the Hasura sources, the
 * bare `webhook` value is NOT itself a plugin (there is no default vendor — config is
 * required), but the typed authoring helpers ARE attached to it, uniform with the
 * Hasura family: `webhook.detector<TBody>(fn)` in an event module, the configured
 * `webhook({ vendor, verify })` in the entry file.
 */
export const webhook: ((config: WebhookConfig) => WebhookSource) & WebhookAuthoring = Object.assign(
  (config: WebhookConfig): WebhookSource => buildWebhook(config),
  { detector, prepare, resolve },
);
