// =============================================================================
// Example event module — `appointment.ready` (ported from the legacy db-appointments
// module, authored 2022-12-30). Demonstrates the Phase 2 Hasura authoring surface:
// the typed `switch (ctx.operation)` detector house style and a declarative handler.
//
// This is an EXAMPLE/fixture — it is type-checked (tsconfig.typetest.json) and
// exercised by the Hasura adapter tests, but excluded from the published build.
// =============================================================================
import { run, job, type JobContext } from '../index.js';
import { hasuraEvent } from '../sources/hasura/index.js';

export interface AppointmentRow {
  id: number;
  status: string;
  customer_id?: number | null;
}

export const detector = hasuraEvent.detector<AppointmentRow>(ctx => {
  const { operation, newRow } = ctx;
  switch (operation) {
    case 'INSERT': {
      // Spark (and other integrations) insert appointments as 'pending' for address
      // resolution; firing the offer SMS + email then would race the lifecycle and
      // the jobs would lack the data they need. Only fire on a direct 'ready' insert.
      const insertedReady = newRow?.status === 'ready';
      return insertedReady;
    }
    case 'UPDATE': {
      const statusChanged = ctx.columnChanged('status');
      const becameReady = newRow?.status === 'ready';
      return statusChanged && becameReady;
    }
    case 'DELETE':
    case 'MANUAL': // suppress Hasura console edits
    default:
      return false;
  }
});

// In a real consumer these live in a jobs/ folder and read live deps (sdk) from
// merged-in input; inlined here so the example is self-contained. The typed
// `JobContext<TInput>` is how a job declares the input shape it reads.
interface OfferInput {
  appointment: AppointmentRow | null;
}

const sendOfferSMS = (ctx: JobContext<OfferInput>) => {
  const { input, log } = ctx;
  const { appointment } = input;
  log.info('Sending offer SMS', { appointmentId: appointment?.id });
  return { sent: 'sms', appointmentId: appointment?.id ?? null };
};

const sendAppointmentOfferedEmailToOrg = (ctx: JobContext<OfferInput>) => {
  const { input, log } = ctx;
  const { appointment } = input;
  log.info('Sending offered email to org', { appointmentId: appointment?.id });
  return { sent: 'email', appointmentId: appointment?.id ?? null };
};

export const handler = hasuraEvent.handler<AppointmentRow>(async (event, ctx) => {
  const { newRow } = ctx;
  return run(event, [
    job(sendOfferSMS, { input: { appointment: newRow } }),
    job(sendAppointmentOfferedEmailToOrg, { input: { appointment: newRow } }),
  ]);
});

export const appointmentReady = { name: 'appointment.ready', detector, handler };
