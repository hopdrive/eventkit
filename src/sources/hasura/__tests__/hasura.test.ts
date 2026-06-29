import { describe, it, expect } from 'vitest';
import { createEventKit, run, job, asEventName, type EventModule, type JobContext } from '../../../index.js';
import { hasuraEvent, hasuraCron } from '../index.js';
import type {
  HasuraCronContext,
  HasuraCronHandlerContext,
  HasuraCronPayload,
  HasuraDetectorContext,
  HasuraEventPayload,
  HasuraHandlerContext,
  HasuraOperation,
} from '../types.js';
import { buildDetectorContextFor, buildHandlerContextFor } from '../../../testing/index.js';
import { detector, handler, type AppointmentRow } from '../../../__examples__/appointment.ready.js';

type Row = Record<string, unknown>;

function payload(
  op: HasuraOperation,
  oldRow: Row | null,
  newRow: Row | null,
  extra: { session?: Record<string, string>; traceId?: string; createdAt?: string } = {},
): HasuraEventPayload {
  return {
    id: 'evt-1',
    created_at: extra.createdAt ?? '2026-06-28T12:00:00.000Z',
    trigger: { name: 'appointments' },
    table: { schema: 'public', name: 'appointments' },
    event: {
      op,
      data: { old: oldRow, new: newRow },
      session_variables: extra.session ?? {
        'x-hasura-role': 'admin',
        'x-hasura-user-id': 'u1',
        'x-hasura-user-email': 'a@b.com',
      },
      ...(extra.traceId ? { trace_context: { trace_id: extra.traceId } } : {}),
    },
    delivery_info: { max_retries: 0, current_retry: 0 },
  };
}

const ctxFor = (p: unknown) => buildDetectorContextFor<HasuraDetectorContext>(hasuraEvent, p);

describe('hasuraEvent.normalize', () => {
  it('derives correlationId from trace_context, receivedAt from created_at, preserves payload', () => {
    const p = payload('UPDATE', { status: 'pending' }, { status: 'ready' }, { traceId: 'trace-xyz' });
    const env = hasuraEvent.normalize!(p, {});
    expect(env.source).toBe('hasura');
    expect(env.sourceType).toBe('database');
    expect(env.correlationId).toBe('trace-xyz');
    expect(env.receivedAt.toISOString()).toBe('2026-06-28T12:00:00.000Z');
    expect(env.payload).toBe(p);
  });

  it('prefers an explicit request.correlationId over the trace id', () => {
    const env = hasuraEvent.normalize!(payload('INSERT', null, { status: 'ready' }, { traceId: 't' }), {
      correlationId: 'explicit',
    });
    expect(env.correlationId).toBe('explicit');
  });

  it('does not throw on a malformed payload', () => {
    expect(() => hasuraEvent.normalize!({}, {})).not.toThrow();
    expect(() => hasuraEvent.normalize!(null, {})).not.toThrow();
  });
});

describe('hasuraEvent detector context helpers', () => {
  it('exposes operation, rows, schema/table and operation predicates', () => {
    const ctx = ctxFor(payload('UPDATE', { id: 1, status: 'pending' }, { id: 1, status: 'ready' }));
    expect(ctx.operation).toBe('UPDATE');
    expect(ctx.schema).toBe('public');
    expect(ctx.table).toBe('appointments');
    expect(ctx.oldRow).toEqual({ id: 1, status: 'pending' });
    expect(ctx.newRow).toEqual({ id: 1, status: 'ready' });
    expect(ctx.row).toEqual({ id: 1, status: 'ready' });
    expect(ctx.updated()).toBe(true);
    expect(ctx.inserted()).toBe(false);
    expect(ctx.deleted()).toBe(false);
    expect(ctx.manuallyInvoked()).toBe(false);
  });

  it('row falls back to oldRow on DELETE', () => {
    const ctx = ctxFor(payload('DELETE', { id: 7, status: 'done' }, null));
    expect(ctx.deleted()).toBe(true);
    expect(ctx.row).toEqual({ id: 7, status: 'done' });
  });

  it('columnChanged is true only when both rows have the column and differ', () => {
    expect(ctxFor(payload('UPDATE', { status: 'pending' }, { status: 'ready' })).columnChanged('status')).toBe(true);
    expect(ctxFor(payload('UPDATE', { status: 'ready' }, { status: 'ready' })).columnChanged('status')).toBe(false);
    // INSERT has no old row → not "changed"
    expect(ctxFor(payload('INSERT', null, { status: 'ready' })).columnChanged('status')).toBe(false);
  });

  it('columnAdded / columnRemoved track null↔value transitions', () => {
    expect(ctxFor(payload('INSERT', null, { phone: '555' })).columnAdded('phone')).toBe(true);
    expect(ctxFor(payload('UPDATE', { phone: null }, { phone: '555' })).columnAdded('phone')).toBe(true);
    expect(ctxFor(payload('UPDATE', { phone: '555' }, { phone: null })).columnRemoved('phone')).toBe(true);
    expect(ctxFor(payload('UPDATE', { phone: '555' }, { phone: '555' })).columnAdded('phone')).toBe(false);
  });

  it('manuallyInvoked() is true for op MANUAL (console edits)', () => {
    expect(ctxFor(payload('MANUAL', { status: 'a' }, { status: 'b' })).manuallyInvoked()).toBe(true);
  });
});

describe('hasuraEvent handler context (data only)', () => {
  it('exposes operation/rows/role/userId/userEmail/receivedAt', () => {
    const ctx = buildHandlerContextFor<HasuraHandlerContext>(
      hasuraEvent,
      payload('UPDATE', { status: 'pending' }, { status: 'ready' }),
    );
    expect(ctx.operation).toBe('UPDATE');
    expect(ctx.newRow).toEqual({ status: 'ready' });
    expect(ctx.role).toBe('admin');
    expect(ctx.userId).toBe('u1');
    expect(ctx.userEmail).toBe('a@b.com');
    expect(ctx.receivedAt.toISOString()).toBe('2026-06-28T12:00:00.000Z');
    // No detection helpers leak onto the handler context
    expect((ctx as unknown as { columnChanged?: unknown }).columnChanged).toBeUndefined();
  });
});

describe('appointment.ready detector (insert/update/delete/manual/malformed)', () => {
  const detect = (p: unknown) => detector(ctxFor(p) as never);

  it('INSERT fires only when inserted directly as ready', async () => {
    expect(await detect(payload('INSERT', null, { id: 1, status: 'ready' }))).toBe(true);
    expect(await detect(payload('INSERT', null, { id: 1, status: 'pending' }))).toBe(false);
  });

  it('UPDATE fires when status changed to ready, not when unchanged', async () => {
    expect(await detect(payload('UPDATE', { status: 'pending' }, { status: 'ready' }))).toBe(true);
    expect(await detect(payload('UPDATE', { status: 'ready' }, { status: 'ready' }))).toBe(false);
    expect(await detect(payload('UPDATE', { status: 'pending' }, { status: 'cancelled' }))).toBe(false);
  });

  it('DELETE and MANUAL never fire; malformed payloads are safe', async () => {
    expect(await detect(payload('DELETE', { status: 'ready' }, null))).toBe(false);
    expect(await detect(payload('MANUAL', { status: 'pending' }, { status: 'ready' }))).toBe(false);
    expect(await detect({})).toBe(false);
    expect(await detect(null)).toBe(false);
  });
});

describe('appointment.ready end to end through a Hasura kit', () => {
  it('detects an UPDATE→ready and runs both jobs with row data', async () => {
    const mod: EventModule = { name: asEventName('appointment.ready'), detector, handler };
    const kit = createEventKit(hasuraEvent).registerEvents([mod]);
    const appt: AppointmentRow = { id: 42, status: 'ready', customer_id: 9 };
    const result = await kit.handle(payload('UPDATE', { id: 42, status: 'pending' }, appt));

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.detected).toBe(true);
    const jobs = result.events[0]!.jobs;
    expect(jobs.map(j => j.jobName).sort()).toEqual(['sendAppointmentOfferedEmailToOrg', 'sendOfferSMS']);
    expect(jobs.every(j => j.status === 'completed')).toBe(true);
    expect(jobs.find(j => j.jobName === 'sendOfferSMS')!.output).toEqual({ sent: 'sms', appointmentId: 42 });
    expect(result.ok).toBe(true);
  });

  it('does not fire on an UPDATE that does not reach ready', async () => {
    const mod: EventModule = { name: asEventName('appointment.ready'), detector, handler };
    const kit = createEventKit(hasuraEvent).registerEvents([mod]);
    const result = await kit.handle(payload('UPDATE', { id: 1, status: 'pending' }, { id: 1, status: 'scheduled' }));
    expect(result.events).toHaveLength(0);
  });
});

// =============================================================================
// hasuraCron (scheduled triggers, ADR-023)
// =============================================================================

function cronPayload(
  name: string,
  cfgPayload: Record<string, unknown> = {},
  scheduledTime = '2026-06-28T00:00:00.000Z',
  id = 'cron-1',
): HasuraCronPayload {
  return { name, scheduled_time: scheduledTime, payload: cfgPayload, id };
}

describe('hasuraCron.normalize', () => {
  it('normalizes a scheduled-trigger payload to a cron envelope', () => {
    const env = hasuraCron.normalize!(cronPayload('monthly-invoices', { month: '2026-06' }), {});
    expect(env.source).toBe('hasura-cron');
    expect(env.sourceType).toBe('cron');
    expect(env.receivedAt.toISOString()).toBe('2026-06-28T00:00:00.000Z');
    expect((env.meta as { sourceEventId?: string }).sourceEventId).toBe('cron-1');
    expect((env.payload as HasuraCronPayload).name).toBe('monthly-invoices');
  });

  it('prefers an explicit request.correlationId and tolerates a malformed payload', () => {
    expect(hasuraCron.normalize!(cronPayload('x'), { correlationId: 'explicit' }).correlationId).toBe('explicit');
    expect(() => hasuraCron.normalize!({}, {})).not.toThrow();
    expect(() => hasuraCron.normalize!(null, {})).not.toThrow();
  });
});

describe('hasuraCron detector context', () => {
  it('exposes scheduleName, scheduledAt, and the configured payload', () => {
    const ctx = buildDetectorContextFor<HasuraCronContext>(hasuraCron, cronPayload('nightly', { tier: 'b2b' }));
    expect(ctx.scheduleName).toBe('nightly');
    expect(ctx.scheduledAt.toISOString()).toBe('2026-06-28T00:00:00.000Z');
    expect(ctx.payload).toEqual({ tier: 'b2b' });
    // no DB-event helpers leak onto a cron context
    expect((ctx as unknown as { operation?: unknown }).operation).toBeUndefined();
  });
});

describe('hasuraCron handler context', () => {
  it('exposes scheduleName/scheduledAt/payload as data', () => {
    const ctx = buildHandlerContextFor<HasuraCronHandlerContext>(hasuraCron, cronPayload('weekly', { region: 'se' }));
    expect(ctx.scheduleName).toBe('weekly');
    expect(ctx.payload).toEqual({ region: 'se' });
    expect(ctx.scheduledAt.toISOString()).toBe('2026-06-28T00:00:00.000Z');
  });
});

describe('hasuraCron end to end', () => {
  it('matches a schedule by name and runs its jobs with the configured payload', async () => {
    let processedMonth = '';
    const detector = hasuraCron.detector(ctx => ctx.scheduleName === 'monthly-invoices');
    const handler = hasuraCron.handler((event, ctx) =>
      run(event, [
        job((c: JobContext) => void (processedMonth = (c.input as { month: string }).month), {
          name: 'processMonthly',
          input: { month: (ctx.payload as { month: string }).month },
        }),
      ]),
    );
    const kit = createEventKit(hasuraCron).registerEvents([
      { name: asEventName('invoices.monthly'), detector, handler } as EventModule,
    ]);

    const result = await kit.handle(cronPayload('monthly-invoices', { month: '2026-06' }));
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.jobs[0]!.status).toBe('completed');
    expect(processedMonth).toBe('2026-06');
  });

  it('does not fire for a different schedule name', async () => {
    const detector = hasuraCron.detector(ctx => ctx.scheduleName === 'monthly-invoices');
    const handler = hasuraCron.handler((event, _ctx) => run(event, []));
    const kit = createEventKit(hasuraCron).registerEvents([
      { name: asEventName('invoices.monthly'), detector, handler } as EventModule,
    ]);
    const result = await kit.handle(cronPayload('hourly-cleanup'));
    expect(result.events).toHaveLength(0);
  });
});
