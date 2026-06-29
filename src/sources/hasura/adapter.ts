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
  HasuraCronContext,
  HasuraCronHandlerContext,
  HasuraCronPayload,
  HasuraDetectorContext,
  HasuraEventPayload,
  HasuraHandlerContext,
  HasuraOperation,
} from './types.js';
import { columnAdded, columnChanged, columnRemoved, getNewRow, getOldRow, getOperation, getSession } from './payload.js';

const randomId = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : `hasura-${Date.now().toString(36)}`;

/**
 * Hasura DB-event payload → EventEnvelope. Tolerant of malformed input: it never
 * throws on a missing field (the detector decides what a missing `operation`
 * means). Correlation id precedence: explicit request → Hasura `trace_context`
 * trace_id → generated.
 */
export function normalizeHasuraEvent(raw: unknown, request: RequestContext): EventEnvelope<HasuraEventPayload> {
  const payload = (raw ?? {}) as HasuraEventPayload;
  const traceId = payload?.event?.trace_context?.trace_id;
  const correlationId = asCorrelationId(request.correlationId ?? traceId ?? randomId());
  const receivedAt = payload?.created_at ? new Date(payload.created_at) : new Date();

  // Surface source attributes into envelope.meta so source-agnostic plugins
  // (observability) can read them without parsing the Hasura payload.
  const session = getSession(payload);
  const meta: SourceMeta = {};
  if (payload?.table) meta.sourceTable = `${payload.table.schema ?? 'public'}.${payload.table.name ?? 'unknown'}`;
  const op = getOperation(payload);
  if (op) meta.sourceOperation = op;
  if (payload?.id) meta.sourceEventId = payload.id;
  if (session['x-hasura-user-email']) meta.sourceUserEmail = session['x-hasura-user-email'];
  if (session['x-hasura-role']) meta.sourceUserRole = session['x-hasura-role'];

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
    inserted: () => operation === 'INSERT',
    updated: () => operation === 'UPDATE',
    deleted: () => operation === 'DELETE',
    manuallyInvoked: () => operation === 'MANUAL',
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
export function normalizeHasuraCron(raw: unknown, request: RequestContext): EventEnvelope<HasuraCronPayload> {
  const payload = (raw ?? {}) as HasuraCronPayload;
  const correlationId = asCorrelationId(request.correlationId ?? randomId());
  const receivedAt = payload?.scheduled_time ? new Date(payload.scheduled_time) : new Date();
  const meta: SourceMeta = {};
  if (payload?.id) meta.sourceEventId = payload.id;

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
