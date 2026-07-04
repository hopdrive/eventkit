// =============================================================================
// eventkit/testing — payload builders (ADR-036, testing-strategy.md §2)
// =============================================================================
// Construct the exact raw payload each source expects, so a consumer test reads
// like the domain ("an appointment row went to 'ready'") instead of hand-assembling
// Hasura/webhook envelopes. Each builder returns the RAW payload the source's
// `normalize` consumes — feed it straight to `testInvocation(kit, …)` or
// `kit.handle(…)`. `webhookRequest(...).signWith(secret)` HMAC-signs the request so
// the `verify` path (and `hmacVerify` preset) is exercised for real.
import { createHmac } from 'node:crypto';
import type { HasuraEventPayload, HasuraCronPayload, HasuraActionPayload, HasuraOperation } from '../plugins/hasura-shared/types.js';

type Row = Record<string, unknown>;

/** Split `'schema.table'` → `{schema, name}`; a bare name defaults to the `public` schema. */
const tableRef = (table: string): { schema: string; name: string } => {
  const dot = table.indexOf('.');
  return dot > 0 ? { schema: table.slice(0, dot), name: table.slice(dot + 1) } : { schema: 'public', name: table };
};

const DEFAULT_SESSION = { 'x-hasura-role': 'admin' } as const;

export interface HasuraEventOptions {
  /** Hasura session variables (defaults to `{ 'x-hasura-role': 'admin' }`). */
  sessionVars?: Record<string, string>;
  /** The event-trigger name (defaults to `'<table>_trigger'`). */
  triggerName?: string;
  /** The event id (defaults to a generated one). */
  id?: string;
  /** A `trace_context.trace_id` — the source folds it into the correlation id when no request id is given. */
  traceId?: string;
}

const randomId = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `test-${Date.now().toString(36)}`;

const hasuraEventPayload = (
  table: string,
  op: HasuraOperation,
  data: { old: Row | null; new: Row | null },
  opts: HasuraEventOptions = {},
): HasuraEventPayload => {
  const t = tableRef(table);
  const event: HasuraEventPayload['event'] = {
    op,
    data,
    session_variables: { ...DEFAULT_SESSION, ...(opts.sessionVars ?? {}) },
  };
  if (opts.traceId) event.trace_context = { trace_id: opts.traceId };
  return {
    id: opts.id ?? randomId(),
    created_at: '2026-01-01T00:00:00.000Z',
    table: t,
    trigger: { name: opts.triggerName ?? `${t.name}_trigger` },
    event,
  } as HasuraEventPayload;
};

/** A Hasura `INSERT` DB-event payload (`old: null`, `new: row`). */
export function hasuraInsert(table: string, newRow: Row, opts?: HasuraEventOptions): HasuraEventPayload {
  return hasuraEventPayload(table, 'INSERT', { old: null, new: newRow }, opts);
}

/**
 * A Hasura `UPDATE` DB-event payload. `updatedBy` (a convenience) is written onto the
 * NEW row's `updated_by` column — the field loopGuard reads for chain provenance — so a
 * chained/echoed write is easy to fabricate.
 */
export function hasuraUpdate(
  table: string,
  oldRow: Row,
  newRow: Row,
  opts: HasuraEventOptions & { updatedBy?: string } = {},
): HasuraEventPayload {
  const { updatedBy, ...rest } = opts;
  const next = updatedBy !== undefined ? { ...newRow, updated_by: updatedBy } : newRow;
  return hasuraEventPayload(table, 'UPDATE', { old: oldRow, new: next }, rest);
}

/**
 * A Hasura console MANUAL edit (`op: 'MANUAL'`). The canonical silent-regression case
 * (D17): a detector that fires on this is re-running side effects for a human's console
 * poke. `detectorContract` auto-appends one of these to every `hasuraEvent` module.
 */
export function hasuraManualEdit(table: string, oldRow: Row | null, newRow: Row | null, opts?: HasuraEventOptions): HasuraEventPayload {
  return hasuraEventPayload(table, 'MANUAL', { old: oldRow, new: newRow }, opts);
}

/** A Hasura `DELETE` DB-event payload (`old: row`, `new: null`). */
export function hasuraDelete(table: string, oldRow: Row, opts?: HasuraEventOptions): HasuraEventPayload {
  return hasuraEventPayload(table, 'DELETE', { old: oldRow, new: null }, opts);
}

/** A Hasura scheduled-trigger (cron) payload `{ name, scheduled_time, payload, id }`. */
export function hasuraCronPayload(name: string, scheduledAt: string | Date, payload: Row = {}): HasuraCronPayload {
  const scheduled_time = typeof scheduledAt === 'string' ? scheduledAt : scheduledAt.toISOString();
  return { id: randomId(), name, scheduled_time, payload } as HasuraCronPayload;
}

/** A Hasura Action payload `{ action:{name}, input, session_variables, request_query? }`. */
export function hasuraActionPayload(
  name: string,
  input: Row = {},
  session: Record<string, string> = { ...DEFAULT_SESSION },
  requestQuery?: string,
): HasuraActionPayload {
  const p: HasuraActionPayload = { action: { name }, input, session_variables: session } as HasuraActionPayload;
  if (requestQuery !== undefined) (p as { request_query?: string }).request_query = requestQuery;
  return p;
}

// ── Webhook request builder ──────────────────────────────────────────────────

/** Brand so `testInvocation` recognizes a built webhook request (body + request.meta). */
const WEBHOOK_REQUEST = Symbol.for('eventkit/testing/webhookRequest');

export interface WebhookRequestInit {
  vendor?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

export interface BuiltWebhookRequest {
  readonly [WEBHOOK_REQUEST]: true;
  /** The parsed body the source receives as the payload. */
  body: unknown;
  /** The `request` object to pass as `handle(body, request)` — carries headers/query/rawBody on `meta`. */
  request: { meta: { headers: Record<string, string>; query: Record<string, string>; rawBody: string } };
  /**
   * HMAC-sign the raw body (Stripe-style `t=<unix>,v1=<hex>` over `${t}.${rawBody}`) and set
   * the signature header, so `hmacVerify({ secret })` verifies it. Returns a new signed request.
   */
  signWith(secret: string, opts?: { header?: string; algorithm?: string; timestamp?: number }): BuiltWebhookRequest;
}

/** True if `x` is a `webhookRequest(...)` result (used by `testInvocation`). */
export function isWebhookRequest(x: unknown): x is BuiltWebhookRequest {
  return !!x && typeof x === 'object' && (x as Record<symbol, unknown>)[WEBHOOK_REQUEST] === true;
}

/**
 * Build an inbound vendor webhook request. The body is JSON-serialized as `rawBody`
 * (so HMAC-over-exact-bytes verification works), and headers/query land on `request.meta`
 * exactly where the platform adapters put them.
 */
export function webhookRequest(init: WebhookRequestInit = {}): BuiltWebhookRequest {
  const body = init.body ?? {};
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const make = (headers: Record<string, string>): BuiltWebhookRequest => ({
    [WEBHOOK_REQUEST]: true,
    body,
    request: { meta: { headers, query: { ...(init.query ?? {}) }, rawBody } },
    signWith(secret, opts = {}) {
      const t = opts.timestamp ?? 1_700_000_000;
      const algorithm = opts.algorithm ?? 'sha256';
      const header = (opts.header ?? 'stripe-signature').toLowerCase();
      const sig = createHmac(algorithm, secret).update(`${t}.${rawBody}`).digest('hex');
      return make({ ...headers, [header]: `t=${t},v1=${sig}` });
    },
  });
  return make({ ...(init.headers ?? {}) });
}
