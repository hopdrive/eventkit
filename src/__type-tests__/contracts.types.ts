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
// ADR-026 (re-amended): the HTTP reply is NOT a module concern — it is declared at
// the invocation layer via kit.handler({ after }). The response is NOT a job option
// either. ADR-020 covers the typed job-context contribution.

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

// ── ADR-026 (re-amended): a module does NOT accept a response — it moved to kit.handler ──
// @ts-expect-error `response` is not a module field — declare kit.handler({ after })
void defineEvent({ name: 'bad.module.response', detector, jobs: [job(work)], response: { static: { a: 1 } } });
// @ts-expect-error the removed `resolve` field is rejected too
void defineEvent({ name: 'bad.module.resolve', detector, jobs: [job(work)], resolve: () => 1 });
// @ts-expect-error the removed `respond` field is rejected too
void defineEvent({ name: 'bad.module.respond', detector, jobs: [job(work)], respond: () => 1 });

// ── the invocation-level `after` declaration (kit.handler) ──────────────────
import { fakeSource } from '../testing/index.js';
const kitFor = () => createEventKit(fakeSource()).registerEvent(defineEvent({ name: 'ok.k', detector, jobs: [job(work)] }));
// constant reply, with the web-standard ResponseInit fields as data:
void kitFor().handler({ after: { static: '<Response/>', status: 201, headers: { 'content-type': 'text/xml' } } });
// dynamic reply: fromResults receives the PRESCRIBED typed rollup (InvocationResult)
void kitFor().handler({
  after: {
    fromResults: result => ({
      ok: result.ok,
      names: result.events.map(e => e.name),
      firstJobStatus: result.events[0]?.jobs[0]?.status,
    }),
  },
});
// the modes are structurally exclusive:
// @ts-expect-error `static` and `fromResults` are mutually exclusive on one declaration
void kitFor().handler({ after: { static: { a: 1 }, fromResults: () => 'x' } });
// a `static` body is DATA — a Promise is not assignable:
// @ts-expect-error a Promise is not a ResponseBody — a static reply cannot wait on work
void kitFor().handler({ after: { static: (async () => ({ ok: true }))() } });

// ── ADR-026 guard: the reply is INVOCATION-level, not a per-job option ───────
// @ts-expect-error `after` is not a JobOptions field — it belongs on kit.handler
void job(work, { after: { static: 'nope' } });

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

// ── a per-job `input` MAPPER sees `ctx.prepared` (module-independent typing) ──
// JobOptions is deliberately independent of any one module's TPrepared (a job(fn, opts)
// can be reused across modules), so a mapper's `ctx.prepared` is Record<string, unknown>.
void defineEvent({
  name: 'ok.mapper.prepared',
  detector,
  prepare: () => ({ base: 10 }),
  jobs: [job((c: JobContext<{ raw: unknown }>) => void c, { input: ctx => ({ raw: ctx.prepared['base'] }) })],
});

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
  jobs: [work],
});
void hasuraCron.defineEvent<{ region: string }>({
  name: 'ok.scoped.cron',
  detector: ctx => ctx.scheduleName === 'nightly' && ctx.payload.region === 'us',
  jobs: [work],
});

// Full inference (no explicit type args): prepare still types itself; jobs run the work.
void webhook.defineEvent({
  name: 'ok.scoped.inferred',
  detector: ctx => ctx.signatureVerified,
  prepare: () => ({ orderId: 42 }),
  jobs: [work],
});
