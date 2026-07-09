// =============================================================================
// Example event module — `appointment.ready` (ported from the legacy db-appointments
// module, authored 2022-12-30). Demonstrates the ADR-025 DECLARATIVE shape:
//   - the typed `switch (ctx.operation)` detector house style (unchanged),
//   - `prepare(ctx)` for the near-universal legacy pattern of initializing the SDK
//     once and sharing it (plus fetched rows) into every job's input,
//   - a STATIC `jobs` array the runtime runs — no handler body, no `run()` call.
//
// This is an EXAMPLE/fixture — type-checked (tsconfig.typetest.json) and exercised
// by the Hasura adapter tests, but excluded from the published build.
// =============================================================================
import { defineEvent, type JobContext } from '../index.js';
import { hasuraEvent } from '../plugins/source-hasura.js';

export interface AppointmentRow {
  id: number;
  status: string;
  customer_id?: number | null;
}

/** A live client — in a real consumer this is the initialized `@hopdrive/sdk`. */
interface ExampleSdk {
  notify(channel: 'sms' | 'email', id: number | null): void;
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

// `prepare` runs ONCE before the jobs. It initializes the shared SDK and fetches the
// row, returning them as a shared object the runtime merges into EVERY job's input.
// This is the migration vehicle for the legacy `sdk.apollo.initialize(...)` + thread
// `sdk` into each job pattern. Data preparation only — it never selects jobs.
export const prepare = hasuraEvent.prepare<AppointmentRow>(ctx => {
  const sdk: ExampleSdk = { notify: () => {} };
  return { sdk, appointment: ctx.newRow ?? null };
});

// Jobs read the shared `sdk` + `appointment` from `ctx.input` (merged from `prepare`)
// and stay plugin-agnostic. The typed `JobContext<TInput>` declares the input shape.
interface OfferInput {
  sdk: ExampleSdk;
  appointment: AppointmentRow | null;
}

const sendOfferSMS = (ctx: JobContext<OfferInput>) => {
  const { input, log } = ctx;
  const { sdk, appointment } = input;
  log.info('Sending offer SMS', { appointmentId: appointment?.id });
  sdk.notify('sms', appointment?.id ?? null);
  return { sent: 'sms', appointmentId: appointment?.id ?? null };
};

const sendAppointmentOfferedEmailToOrg = (ctx: JobContext<OfferInput>) => {
  const { input, log } = ctx;
  const { sdk, appointment } = input;
  log.info('Sending offered email to org', { appointmentId: appointment?.id });
  sdk.notify('email', appointment?.id ?? null);
  return { sent: 'email', appointmentId: appointment?.id ?? null };
};

// Pattern-B job (ADR-035): unconditional in the array, short-circuits with ctx.skip when
// it has no work. The skip records `condition_not_met` with a reason so the no-op is
// visible in observability — not a silent `return`.
const notifyCustomer = (ctx: JobContext<OfferInput>) => {
  const { input, log } = ctx;
  const customerId = input.appointment?.customer_id;
  if (!customerId) return ctx.skip('no customer on this appointment');
  log.info('Notifying customer', { customerId });
  input.sdk.notify('sms', customerId);
};

// The module is a declarative record: detector + prepare + a STATIC jobs array.
// No conditional inclusion is possible — there is no handler body to branch in.
//
// D32: `prepare`'s inferred return type is threaded through `defineEvent` into
// the response fn's `ctx.prepared` — no cast, no restatement. See the compile-checked
// fixtures in `src/__type-tests__/contracts.types.ts` (`ok.typed.prepare.fromRequest` /
// `ok.typed.prepare.fromJobs`) for that guarantee under test.
export const appointmentReady = defineEvent({
  name: 'appointment.ready',
  detector,
  prepare,
  // Bare job functions — auto-wrapped to job(fn); the job name comes from fn.name.
  // Wrap in job(fn, {…}) only when a job needs options (retries, timeoutMs, input, …).
  jobs: [sendOfferSMS, sendAppointmentOfferedEmailToOrg, notifyCustomer],
});
