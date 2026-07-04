// =============================================================================
// eventkit/sources/webhook — verify presets (D33)
// =============================================================================
// Generic, reusable signature/token checks for `webhook({ verify })`, so each repo
// stops hand-rolling the same handful of schemes. Every preset returns a synchronous
// `(args: WebhookVerifyArgs) => boolean` — true iff the request is authentic. Secrets
// arrive captured in the factory closure (the source never reads process.env), matching
// the `verify` contract. Verification never throws to the caller: a malformed/absent
// signature is a clean `false`.
//
// These are DEFENSIVE building blocks. Pair with `rejectUnverified` to reject a forged
// request at one chokepoint, or read `ctx.signatureVerified` in the detector (§7.1).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookVerifyArgs } from './index.js';

/** Constant-time string compare; a length mismatch short-circuits to false (still constant-time per length). */
const safeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
};

export interface HmacVerifyConfig {
  /** The signing secret (captured, never read from env by the source). */
  secret: string;
  /** Header carrying the signature. Default `'stripe-signature'` (case-insensitive). */
  header?: string;
  /** Hash algorithm. Default `'sha256'`. */
  algorithm?: string;
  /**
   * Max allowed age of the signed timestamp, in seconds. Omit to skip the freshness
   * check (signature-only). When set, a `t=` older than `now - toleranceSeconds`
   * (or with no `t=`) is rejected — the standard replay guard.
   */
  toleranceSeconds?: number;
}

/**
 * Stripe-style HMAC signature: the header is `t=<unix>,v1=<hexHMAC>[,v0=...]`, and the
 * signed payload is `<t>.<rawBody>`. Requires the platform-preserved `rawBody` (HMAC is
 * over the exact bytes) — without it, verification safely fails. Also handles a bare
 * hex-HMAC header (no `t=`/`v1=`) computed over the raw body directly.
 */
export function hmacVerify(config: HmacVerifyConfig): (args: WebhookVerifyArgs) => boolean {
  const headerName = (config.header ?? 'stripe-signature').toLowerCase();
  const algorithm = config.algorithm ?? 'sha256';
  return ({ headers, rawBody }: WebhookVerifyArgs): boolean => {
    if (typeof rawBody !== 'string') return false; // can't HMAC without the exact bytes
    const raw = headers[headerName];
    if (!raw) return false;

    // Parse the comma/space-separated `k=v` scheme (Stripe). A bare token is treated as v1.
    const parts: Record<string, string> = {};
    let bare = raw.trim();
    if (raw.includes('=')) {
      for (const seg of raw.split(',')) {
        const [k, ...rest] = seg.trim().split('=');
        if (k && rest.length) parts[k] = rest.join('=');
      }
    }
    const t = parts['t'];
    const v1 = parts['v1'] ?? (raw.includes('=') ? undefined : bare);
    if (!v1) return false;

    if (config.toleranceSeconds !== undefined) {
      const ts = Number.parseInt(t ?? '', 10);
      if (!Number.isFinite(ts)) return false;
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSeconds - ts) > config.toleranceSeconds) return false;
    }

    const signedPayload = t ? `${t}.${rawBody}` : rawBody;
    const expected = createHmac(algorithm, config.secret).update(signedPayload).digest('hex');
    return safeEqual(expected, v1);
  };
}

export interface StaticHeaderTokenConfig {
  /** Header carrying the token (case-insensitive). */
  header: string;
  /** The exact expected token value. */
  token: string;
}

/** A fixed shared token in a named header (e.g. `Authorization: Bearer <token>` via `header: 'authorization'`). */
export function staticHeaderToken(config: StaticHeaderTokenConfig): (args: WebhookVerifyArgs) => boolean {
  const headerName = config.header.toLowerCase();
  return ({ headers }: WebhookVerifyArgs): boolean => {
    const got = headers[headerName];
    return typeof got === 'string' && safeEqual(got, config.token);
  };
}

export interface SharedSecretConfig {
  /** The expected secret value. */
  secret: string;
  /** Header to read the secret from (case-insensitive). Checked before `queryParam`. */
  header?: string;
  /** Query param to read the secret from (case-sensitive). Some vendors put it on the URL. */
  queryParam?: string;
}

/**
 * A shared secret presented in a header OR a query param (super-dispatch-style vendors
 * key their token on the URL). Provide at least one of `header`/`queryParam`.
 */
export function sharedSecret(config: SharedSecretConfig): (args: WebhookVerifyArgs) => boolean {
  const headerName = config.header?.toLowerCase();
  const { queryParam } = config;
  return ({ headers, query }: WebhookVerifyArgs): boolean => {
    if (headerName) {
      const h = headers[headerName];
      if (typeof h === 'string' && safeEqual(h, config.secret)) return true;
    }
    if (queryParam) {
      const q = query[queryParam];
      if (typeof q === 'string' && safeEqual(q, config.secret)) return true;
    }
    return false;
  };
}

export interface HasuraPassphraseConfig {
  /** The configured passphrase Hasura sends on its event-trigger webhook. */
  passphrase: string;
  /** Header carrying it. Default `'x-hasura-webhook-secret'` (case-insensitive). */
  header?: string;
}

/** Hasura event-trigger webhook passphrase: a shared secret in a conventional header. */
export function hasuraPassphrase(config: HasuraPassphraseConfig): (args: WebhookVerifyArgs) => boolean {
  return staticHeaderToken({ header: config.header ?? 'x-hasura-webhook-secret', token: config.passphrase });
}
