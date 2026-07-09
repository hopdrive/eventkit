// =============================================================================
// Negative-type contract fixtures (compile-only; never executed)
// =============================================================================
// Compiled by `tsconfig.typetest.json` (run in CI). Each `@ts-expect-error` asserts
// that a specific misuse FAILS to type-check. If a guard regresses, the expected
// error disappears, the directive becomes "unused", and tsc fails the build.
//
// ADR-025: a module declares a STATIC `jobs` array; there is no handler body, so
// imperative conditional inclusion (`if (x) jobs.push(...)`) is structurally
// IMPOSSIBLE — there is nowhere to write it. The branded `JobDefinition` remains a
// backstop against the one expressible form, `cond && job(...)` inside the array
// literal (type `false | JobDefinition`), and against non-job entries.
//
// ADR-026 (amended): a request/response module adds a module-level `response`
// declaration and `jobs` become optional (a response-only module is valid). The
// response is NOT a job option. ADR-020 covers the typed job-context contribution.

import { job, defineEvent } from '../index.js';
import { webhook } from '../plugins/source-webhook/index.js';
import type { JobContext, EventKitPlugin } from '../core/index.js';

const work = (_ctx: JobContext): void => {};
declare const detector: () => boolean;

// ── ADR-025: a static array of branded jobs is accepted ─────────────────────
void defineEvent({ name: 'ok.event', detector, jobs: [job(work), job(work, { timeoutMs: 100 })] });

// ── ADR-025 (amended): a BARE job function is accepted (auto-wrapped → job(fn)) ──
void defineEvent({ name: 'ok.bare', detector, jobs: [work] });
// ── …and bare + wrapped may be mixed (wrap only when you need options) ───────
void defineEvent({ name: 'ok.mixed', detector, jobs: [work, job(work, { retries: 2 })] });

// ── ADR-025/018 guard: `cond && job(...)` is `false | JobDefinition`, NOT a job ──
declare const cond: boolean;
// @ts-expect-error a conditional entry (false | JobDefinition) is not assignable to the jobs element type
void defineEvent({ name: 'bad.cond', detector, jobs: [cond && job(work)] });

// ── ADR-025 guard: a conditional BARE fn is `false | JobFunction` — still rejected ──
// (auto-wrapping bare fns does NOT reopen conditional inclusion: `false` is neither
//  a JobDefinition nor a function, so it is not assignable to the element type.)
// @ts-expect-error a conditional bare fn (false | JobFunction) is not assignable
void defineEvent({ name: 'bad.cond.fn', detector, jobs: [cond && work] });

// ── ADR-025 guard: a bare entry must be JOBFUNCTION-SHAPED (param ⊇ JobContext),
// not merely "any function" — a function whose parameter is incompatible with
// `JobContext` is rejected (strictFunctionTypes contravariance). So a stray helper
// reference can't slip into `jobs`. (Zero-arg fns and explicit-`any`-param fns are
// accepted — both are inherently JobContext-compatible and are legitimate jobs.)
// @ts-expect-error a number-param function is not a JobFunction (ctx: JobContext)
void defineEvent({ name: 'bad.numparam', detector, jobs: [(_n: number) => 1] });
// @ts-expect-error a specific-object-param function is not JobFunction-shaped
void defineEvent({ name: 'bad.objparam', detector, jobs: [(_deps: { db: string }) => 1] });
// a zero-arg function IS accepted (a job that ignores ctx)
void defineEvent({ name: 'ok.zeroarg', detector, jobs: [() => 'ok'] });

// ── ADR-025/018 guard: a look-alike object without the brand is rejected ────
// @ts-expect-error not branded and not a function
void defineEvent({ name: 'bad.lookalike', detector, jobs: [{ fn: work, name: 'x', options: {} }] });

// ── ADR-025/018 guard: a falsy/empty entry is rejected ──────────────────────
// @ts-expect-error null is neither a JobDefinition nor a function
void defineEvent({ name: 'bad.null', detector, jobs: [null] });

// Note: there is no `handler` field to put an `if`/ternary/`.push` in — conditional
// job inclusion is impossible by construction. A condition lives in the `detector` (a
// distinct business event) or inside a job body (input-driven). See ADR-025 §19.1.

// ── ADR-026: a request/response module compiles with a `response` and NO `jobs` ──
void defineEvent({ name: 'ok.response', detector, response: { fromRequest: () => ({ accessToken: 't', userId: 1 }) } });
// …and the fixed-body mode is pure data:
void defineEvent({ name: 'ok.response.json', detector, response: { json: { received: true } } });

// ── ADR-026: a `response` + optional `jobs` (fire-and-forget side effects) compiles ──
void defineEvent({ name: 'ok.response.jobs', detector, response: { fromRequest: () => 'ok' }, jobs: [job(work)] });

// ── the modes are structurally exclusive — declaring two at once fails to compile ──
// @ts-expect-error `json` and `fromRequest` are mutually exclusive on one declaration
void defineEvent({ name: 'bad.dual.mode', detector, response: { json: { a: 1 }, fromRequest: () => 'x' } });

// ── a fixed `json` body is DATA — a Promise (i.e. an async computation) is not assignable ──
// @ts-expect-error a Promise is not a ResponseBody — a fixed body cannot wait on work
void defineEvent({ name: 'bad.json.promise', detector, response: { json: (async () => ({ ok: true }))() } });

// ── ADR-026 guard: the response is MODULE-level, not a per-job option ────────
// @ts-expect-error `response` is not a JobOptions field — it belongs on the module
void job(work, { response: { fromRequest: () => 'nope' } });

// (A module with neither `jobs` nor a `response` is a do-nothing config error — caught at
// REGISTER time, not by the type, now that both are optional. See runtime tests.)

// ── ADR-020: a valid job-context contribution type-checks ───────────────────
const validPlugin: EventKitPlugin = {
  name: 'valid-contributor',
  augmentJobContext: () => ({ input: { workUnit: 1 }, ambient: { trackingToken: 'tok' } }),
};
void validPlugin;

// ── ADR-020 guard: `ambient` is not an open bag — only known fields land ────
const badAmbient: EventKitPlugin = {
  name: 'bad-ambient',
  // @ts-expect-error `nope` is not a contributable ambient field
  augmentJobContext: () => ({ ambient: { nope: true } }),
};
void badAmbient;

// ── ADR-020 guard: the old `context` channel is gone (merged into a void) ────
const deadContext: EventKitPlugin = {
  name: 'dead-context',
  // @ts-expect-error `context` is not part of the contribution contract (use `input`/`ambient`)
  augmentJobContext: () => ({ context: { foo: 1 } }),
};
void deadContext;

// ── D32: `prepare`'s inferred return type flows into the response fns' ctx.prepared ──
// The inferred TPrepared is threaded through defineEvent, so these seams read prepared
// data with NO cast and NO restatement. A missing/misspelled prepared key is a compile error.
void defineEvent({
  name: 'ok.typed.prepare.fromRequest',
  detector,
  prepare: () => ({ base: 10, label: 'x' }),
  // ctx.prepared is typed as { base: number; label: string } — arithmetic + string ops type-check
  response: { fromRequest: ctx => ({ total: ctx.prepared.base + 5, upper: ctx.prepared.label.toUpperCase() }) },
});

void defineEvent({
  name: 'ok.typed.prepare.fromJobs',
  detector,
  prepare: async () => ({ threshold: 3 }),
  jobs: [job(work)],
  response: { fromJobs: (ctx, { ok }) => ({ ok, over: ctx.prepared.threshold > 0 }) },
});

// @ts-expect-error `missing` is not a key of the inferred prepared type { base: number }
void defineEvent({ name: 'bad.prepared.key', detector, prepare: () => ({ base: 1 }), response: { fromRequest: ctx => ctx.prepared.missing } });

// @ts-expect-error prepared.base is a number — `.toUpperCase()` is not a number method
void defineEvent({ name: 'bad.prepared.type', detector, prepare: () => ({ base: 1 }), response: { fromRequest: ctx => ctx.prepared.base.toUpperCase() } });

// ── Webhook authoring generics: `webhook.detector<TBody>` types ctx.body on the BARE factory ──
// The helpers are attached to the factory value itself (uniform with the Hasura family),
// so an event module types its contexts without knowing the entry file's vendor config.
type StripeEvent = { type: string; data: { object: { id: string; amount: number } } };
void webhook.detector<StripeEvent>(ctx => ctx.signatureVerified && ctx.body.type === 'payment_intent.succeeded');
void webhook.prepare<StripeEvent>(ctx => ({ paymentIntentId: ctx.body.data.object.id }));

// @ts-expect-error `missing` is not a key of the typed StripeEvent body
void webhook.detector<StripeEvent>(ctx => ctx.body.missing === true);

// ── Source-scoped defineEvent: the type on the OUTER call flows into bare inline seams ──
// `hasuraEvent.defineEvent<Row>({ detector: (ctx) => … })` — one type parameter on the
// outer call, and every inline arrow (`detector`/`prepare`/the `response` fns) receives
// the SOURCE-enriched context. No per-seam `.detector()` wrapper needed.
import { hasuraEvent, hasuraCron, hasuraAction } from '../plugins/source-hasura.js';
import { createEventKit } from '../index.js';

interface ScopedRow {
  id: number;
  status: string;
}

const scopedModule = hasuraEvent.defineEvent<ScopedRow>({
  name: 'ok.scoped.hasura',
  // bare inline arrow: ctx is HasuraDetectorContext<ScopedRow> — operation/columnChanged/newRow all typed
  detector: ctx => {
    switch (ctx.operation) {
      case 'UPDATE':
        return ctx.columnChanged('status') && ctx.newRow?.status === 'ready';
      default:
        return false;
    }
  },
  // bare inline prepare: ctx is HasuraHandlerContext<ScopedRow>
  prepare: ctx => ({ row: ctx.newRow }),
  jobs: [work, job(work, { retries: 1 })],
});
// …and the result registers like any module.
void createEventKit(hasuraEvent).registerEvent(scopedModule);

// The row type really flowed into the inline arrow:
void hasuraEvent.defineEvent<ScopedRow>({
  name: 'bad.scoped.rowkey',
  // @ts-expect-error ScopedRow has no `nope`
  detector: ctx => ctx.newRow?.nope === 1,
  jobs: [work],
});

// The ADR-025 conditional-entry guard survives the scoped form.
void hasuraEvent.defineEvent<ScopedRow>({
  name: 'bad.scoped.cond',
  detector: ctx => !!ctx.newRow,
  // @ts-expect-error a conditional entry (false | JobDefinition) is not a job entry
  jobs: [cond && job(work)],
});

// webhook.defineEvent<TBody>: ctx.body typed from the outer call, on the BARE factory.
void webhook.defineEvent<StripeEvent>({
  name: 'ok.scoped.webhook',
  detector: ctx => ctx.signatureVerified && ctx.body.type === 'payment_intent.succeeded',
  prepare: ctx => ({ paymentIntentId: ctx.body.data.object.id }),
  response: { json: { received: true } },
  jobs: [work],
});
void webhook.defineEvent<StripeEvent>({
  name: 'bad.scoped.webhook.body',
  // @ts-expect-error `missing` is not a key of the typed StripeEvent body
  detector: ctx => ctx.body.missing === true,
});

// hasuraAction / hasuraCron scoped forms: default type params still give the enriched ctx.
void hasuraAction.defineEvent({
  name: 'ok.scoped.action',
  detector: ctx => ctx.actionName === 'cancelAppointment',
  response: { fromRequest: ctx => ({ ok: true, by: ctx.sessionVariables.userId }) },
});
void hasuraCron.defineEvent<{ region: string }>({
  name: 'ok.scoped.cron',
  detector: ctx => ctx.scheduleName === 'nightly' && ctx.payload.region === 'us',
  jobs: [work],
});

// Full inference (no explicit type args) still threads TPrepared into the response fn (D32).
void webhook.defineEvent({
  name: 'ok.scoped.inferred',
  detector: ctx => ctx.signatureVerified,
  prepare: () => ({ orderId: 42 }),
  response: { fromRequest: ctx => {
    const n: number = ctx.prepared.orderId; // typed number, not unknown
    return n;
  } },
});
