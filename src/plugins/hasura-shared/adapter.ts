// hasuraEvent capability implementations: normalize + buildDetectorContext +
// buildHandlerContext (§7, §9.2). Kept separate from the authoring/assembly in
// index.ts so the pure source mechanics are easy to read and test.
import {
  asCorrelationId,
  asEventSourceName,
  type DetectorContext,
  type EventEnvelope,
  type HandlerContext,
  type RequestContext,
} from '../../core/index.js';
import type { SourceMeta } from '../../core/index.js';
import type {
  HasuraActionContext,
  HasuraActionHandlerContext,
  HasuraActionPayload,
  HasuraActionSession,
  HasuraCronContext,
  HasuraCronHandlerContext,
  HasuraCronPayload,
  HasuraDetectorContext,
  HasuraEventPayload,
  HasuraHandlerContext,
  HasuraOperation,
} from './types.js';
import { columnAdded, columnChanged, columnRemoved, getNewRow, getOldRow, getOperation, getSession } from './payload.js';
import { collectTokenCandidates, type HasuraTokenDiscoveryConfig } from './token-discovery.js';
import { randomId as sharedRandomId } from '../../core/ids.js';

const randomId = (): string => sharedRandomId('hasura');

/** Config for the Hasura DB-event normalize: token discovery plus the trace-id policy. */
export interface HasuraEventNormalizeConfig extends HasuraTokenDiscoveryConfig {
  /**
   * Adopt the inbound `trace_context.trace_id` as the correlation id when the request
   * carries no explicit `correlationId`. Default `false`.
   *
   * The trace id is a CLIENT-controlled conveyance channel (a browser sends it as
   * `x-b3-traceid`). Using it as chain identity has two problems: a client that sends
   * a static trace id per action merges every unrelated chain that used that action
   * into one, and a client gets to dictate the chain's identity. So by default the
   * chain's correlation id is minted fresh at the root exactly as if no trace id
   * arrived, and the raw trace id is surfaced on `meta.sourceTraceId` for a decoder
   * plugin to read. Set this `true` only when a consumer genuinely wants the old
   * trace-adoption behavior (e.g. a trusted internal caller that mints real, unique
   * trace ids per request).
   */
  correlationFromTraceId?: boolean;
}

/**
 * Hasura DB-event payload → EventEnvelope. Tolerant of malformed input: it never
 * throws on a missing field (the detector decides what a missing `operation`
 * means). Correlation id precedence: explicit request → generated. The inbound
 * `trace_context.trace_id` is NOT adopted as the correlation id by default (it is a
 * client-controlled conveyance channel, surfaced on `meta.sourceTraceId`); set
 * `correlationFromTraceId: true` to restore the old adopt-the-trace-id behavior.
 */
export function normalizeHasuraEvent(
  raw: unknown,
  request: RequestContext,
  config: HasuraEventNormalizeConfig = {},
): EventEnvelope<HasuraEventPayload> {
  const payload = (raw ?? {}) as HasuraEventPayload;
  const traceId = payload?.event?.trace_context?.trace_id;
  const traceCorrelation = config.correlationFromTraceId ? traceId : undefined;
  const correlationId = asCorrelationId(request.correlationId ?? traceCorrelation ?? randomId());
  const receivedAt = payload?.created_at ? new Date(payload.created_at) : new Date();

  // Surface source attributes into envelope.meta so source-agnostic plugins
  // (observability) can read them without parsing the Hasura payload.
  const session = getSession(payload);
  const meta: SourceMeta = {};
  if (payload?.trigger?.name) meta.sourceFunction = payload.trigger.name;
  if (payload?.table) meta.sourceTable = `${payload.table.schema ?? 'public'}.${payload.table.name ?? 'unknown'}`;
  const op = getOperation(payload);
  if (op) meta.sourceOperation = op;
  if (payload?.id) meta.sourceEventId = payload.id;
  if (session['x-hasura-user-email']) meta.sourceUserEmail = session['x-hasura-user-email'];
  if (session['x-hasura-role']) meta.sourceUserRole = session['x-hasura-role'];
  // Surface the raw inbound trace id (conveyance only) so a decoder plugin can read it.
  // This is independent of whether it was adopted as the correlation id above.
  if (traceId) meta.sourceTraceId = traceId;

  // Inbound token discovery (ADR-039.2): the row write field then session variables.
  const row = getNewRow(payload) ?? getOldRow(payload);
  const tokenCandidates = collectTokenCandidates(row, session, config);
  if (tokenCandidates.length > 0) meta.tokenCandidates = tokenCandidates;

  return {
    id: payload?.id ?? randomId(),
    source: asEventSourceName('hasura'),
    sourceType: 'database',
    receivedAt,
    correlationId,
    payload,
    meta: meta as Record<string, unknown>,
    raw,
  };
}

/** Build the flattened Hasura detector context (full ctx — the runtime does not merge). */
export function buildHasuraDetectorContext(
  envelope: EventEnvelope<HasuraEventPayload>,
  base: DetectorContext<HasuraEventPayload>,
): HasuraDetectorContext {
  const payload = envelope.payload;
  const operation = getOperation(payload);
  const oldRow = getOldRow(payload);
  const newRow = getNewRow(payload);
  const row = newRow ?? oldRow ?? null;

  return {
    ...base,
    operation: operation as HasuraOperation,
    schema: payload?.table?.schema ?? '',
    table: payload?.table?.name ?? '',
    oldRow,
    newRow,
    row,
    columnChanged: col => columnChanged(oldRow, newRow, String(col)),
    columnAdded: col => columnAdded(oldRow, newRow, String(col)),
    columnRemoved: col => columnRemoved(oldRow, newRow, String(col)),
    previousValue: col => oldRow?.[col as string] as never,
    currentValue: col => newRow?.[col as string] as never,
  } as HasuraDetectorContext;
}

/** Build the Hasura handler-context EXTENSION (DATA only; runtime merges onto base). */
export function buildHasuraHandlerContext(
  envelope: EventEnvelope<HasuraEventPayload>,
  _base: HandlerContext<HasuraEventPayload>,
): Omit<HasuraHandlerContext, keyof HandlerContext<HasuraEventPayload>> {
  const payload = envelope.payload;
  const session = getSession(payload);
  const oldRow = getOldRow(payload);
  const newRow = getNewRow(payload);

  return {
    operation: getOperation(payload) as HasuraOperation,
    oldRow,
    newRow,
    row: newRow ?? oldRow ?? null,
    role: session['x-hasura-role'] ?? null,
    userId: session['x-hasura-user-id'] ?? null,
    userEmail: session['x-hasura-user-email'] ?? null,
    receivedAt: envelope.receivedAt,
  };
}

// ── hasuraCron (Hasura scheduled triggers, ADR-023) ──────────────────────────

/**
 * Hasura scheduled-trigger payload `{ name, scheduled_time, payload, id }` →
 * EventEnvelope. `sourceType: 'cron'`. No `trace_context`, so correlation comes
 * from the request or is generated. Tolerant of malformed input.
 */
export function normalizeHasuraCron(
  raw: unknown,
  request: RequestContext,
  config: HasuraTokenDiscoveryConfig = {},
): EventEnvelope<HasuraCronPayload> {
  const payload = (raw ?? {}) as HasuraCronPayload;
  const correlationId = asCorrelationId(request.correlationId ?? randomId());
  const receivedAt = payload?.scheduled_time ? new Date(payload.scheduled_time) : new Date();
  const meta: SourceMeta = {};
  if (payload?.name) meta.sourceFunction = payload.name; // the schedule name identifies the cron function
  if (payload?.id) meta.sourceEventId = payload.id;

  // A cron payload carries neither a row nor session variables — wire the reader with
  // nulls so the config surface stays uniform across the family. A deliberate no-op.
  const tokenCandidates = collectTokenCandidates(null, null, config);
  if (tokenCandidates.length > 0) meta.tokenCandidates = tokenCandidates;

  return {
    id: payload?.id ?? randomId(),
    source: asEventSourceName('hasura-cron'),
    sourceType: 'cron',
    receivedAt,
    correlationId,
    payload,
    meta: meta as Record<string, unknown>,
    raw,
  };
}

/** Build the cron detector context (full ctx — schedule name + time + payload). */
export function buildHasuraCronDetectorContext(
  envelope: EventEnvelope<HasuraCronPayload>,
  base: DetectorContext<HasuraCronPayload>,
): HasuraCronContext {
  const payload = envelope.payload;
  return {
    ...base,
    scheduleName: payload?.name ?? '',
    scheduledAt: payload?.scheduled_time ? new Date(payload.scheduled_time) : envelope.receivedAt,
    payload: payload?.payload ?? {},
  } as HasuraCronContext;
}

/** Build the cron handler-context EXTENSION (schedule data only; runtime merges onto base). */
export function buildHasuraCronHandlerContext(
  envelope: EventEnvelope<HasuraCronPayload>,
  _base: HandlerContext<HasuraCronPayload>,
): Omit<HasuraCronHandlerContext, keyof HandlerContext<HasuraCronPayload>> {
  const payload = envelope.payload;
  return {
    scheduleName: payload?.name ?? '',
    scheduledAt: payload?.scheduled_time ? new Date(payload.scheduled_time) : envelope.receivedAt,
    payload: payload?.payload ?? {},
  };
}

// ── hasuraAction (request/response — §7.2, ADR-026) ──────────────────────────

/** Session identity from the lowercase `x-hasura-*` keys (null when absent). */
function actionSession(payload: HasuraActionPayload | undefined): HasuraActionSession {
  const s = (payload?.session_variables ?? {}) as Record<string, string | undefined>;
  return {
    role: s['x-hasura-role'] ?? null,
    userId: s['x-hasura-user-id'] ?? null,
    email: s['x-hasura-user-email'] ?? null,
  };
}

const actionFields = (envelope: EventEnvelope<HasuraActionPayload>) => {
  const p = envelope.payload;
  return {
    actionName: p?.action?.name ?? '',
    input: (p?.input ?? {}) as Record<string, unknown>,
    sessionVariables: actionSession(p),
    requestQuery: p?.request_query,
  };
};

/**
 * Hasura Action payload (`{ action, input, session_variables, request_query }`) →
 * EventEnvelope. `sourceType: 'action'`. Correlation from the request or generated.
 * Tolerant of malformed input (never throws — the detector decides).
 */
export function normalizeHasuraAction(
  raw: unknown,
  request: RequestContext,
  config: HasuraTokenDiscoveryConfig = {},
): EventEnvelope<HasuraActionPayload> {
  const payload = (raw ?? {}) as HasuraActionPayload;
  const correlationId = asCorrelationId(request.correlationId ?? randomId());
  const session = (payload?.session_variables ?? {}) as Record<string, string | undefined>;
  const meta: SourceMeta = {};
  if (payload?.action?.name) meta.sourceFunction = payload.action.name; // the action name identifies the function
  if (session['x-hasura-user-email']) meta.sourceUserEmail = session['x-hasura-user-email'];
  if (session['x-hasura-role']) meta.sourceUserRole = session['x-hasura-role'];

  // An action carries no row — token discovery reads only the session variables.
  const tokenCandidates = collectTokenCandidates(null, session, config);
  if (tokenCandidates.length > 0) meta.tokenCandidates = tokenCandidates;

  return {
    id: randomId(),
    source: asEventSourceName('hasura-action'),
    sourceType: 'action',
    receivedAt: new Date(),
    correlationId,
    payload,
    meta: meta as Record<string, unknown>,
    raw,
  };
}

/** Build the action detector context (full ctx — actionName + input + session). */
export function buildHasuraActionDetectorContext(
  envelope: EventEnvelope<HasuraActionPayload>,
  base: DetectorContext<HasuraActionPayload>,
): HasuraActionContext {
  return { ...base, ...actionFields(envelope) } as HasuraActionContext;
}

/** Build the action handler-context EXTENSION (data only; runtime merges onto base). */
export function buildHasuraActionHandlerContext(
  envelope: EventEnvelope<HasuraActionPayload>,
  _base: HandlerContext<HasuraActionPayload>,
): Omit<HasuraActionHandlerContext, keyof HandlerContext<HasuraActionPayload>> {
  return actionFields(envelope);
}
