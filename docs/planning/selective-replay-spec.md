# Design Spec: Selective Replay

**Status:** ratified — **ADR-042** (selective replay, D40) and **ADR-043** (declarative job
config, D41) in `architecture.md` v0.3.24; implementation prompt issued. Supersedes the
exploration in `selective-replay.md` (kept for the why); this document is the what and how.
Console sections target **`console/` in THIS repo** — the console has been migrated here
from `hasura-event-detector/packages/console` per `console-migration-plan.md` (Netlify
deployment, `netlify/functions/` for server-side proxies, no client-side secrets). It reads
the same observability schema eventkit's `graphqlSink` writes.

Everything here was verified against source on 2026-07-03; file references are
eventkit-repo paths unless prefixed.

---

## 1. Overview

Selective replay lets an operator re-send a recorded invocation to its function and choose
which jobs actually execute. Unselected jobs are recorded as `status: 'skipped'` with reason
`rerun job not selected` — first-class rows, not absences. The replayed invocation rejoins
the original correlation chain and carries an explicit `replay of` marker.

**Goals**
- Rerun exactly the chosen jobs of a recorded invocation, with the recorded payload.
- Every non-chosen job visible as a skipped execution with a reason.
- Full audit: which invocation was replayed, what was selected, by which request.
- Zero bypass of function auth, webhook signature verification, or loop protection.
- Console UX to drive it from the invocation views.

**Non-goals**
- Re-evaluating *current* row state (the status-flip replay remains that tool).
- Scheduling/queueing replays, bulk replay, cron replay (future).
- Durable retry semantics (Batch owns that).
- Replaying into a *different* function or environment than the record's.

## 2. Definitions

- **Original invocation** — the recorded invocation being replayed (`replayOf` target).
- **Directive** — the `x-eventkit-replay-*` headers on the re-POST.
- **Selection** — the parsed structure naming which jobs run.
- **Selected / unselected job** — per the matching rules in §3.3.
- **Replay-skip** — the framework finishing a job `'skipped'` without running it.

---

## 3. Wire protocol (normative)

A replay is an HTTP POST to the SAME function endpoint as the original, with:

1. **Body**: byte-identical to the original request body (`source_event_payload` /
   recorded `rawBody`). The body is never wrapped or annotated — `normalize` must see
   exactly what the source sent, and webhook HMAC re-verification requires exact bytes.
2. **Headers**: the functional subset of the original headers (§10.4 allowlist), plus the
   directive headers, plus (by default) the original inbound tracking-token header so
   lineage reattaches.

### 3.1 Directive headers

| Header | Required | Value |
|---|---|---|
| `x-eventkit-replay-of` | yes, for any replay | the original invocation id (uuid text) |
| `x-eventkit-replay-jobs` | no | JSON selection (§3.2). Absent ⇒ full replay (all jobs run), still marked as a replay |
| `x-eventkit-replay-auth` | only if the kit configures `requireToken` | shared secret, constant-time compared |

Headers are the only channel. They reach every source identically via
`RequestContext.meta.headers` (all platform adapters lowercase and stash them —
`src/plugins/platform-shared.ts requestMeta`).

### 3.2 Selection JSON

Two accepted forms:

```json
{"ridehail.pending": ["callRide"], "ridehail.audit": []}   // scoped form
["callRide", "retryCallRide"]                                // flat form
```

- **Scoped form** (`Record<string, string[]>`): keys are event (module) names, values are
  job names to RUN for that event. An empty array = detect the event, skip all its jobs.
- **Flat form** (`string[]`): job names to RUN wherever they appear, across all detected
  events.
- Maximum encoded length 8 KiB (sanity bound; reject larger with 400).

### 3.3 Matching rules (normative)

Given a detected event `E` and a job definition `J` (identity = the module's registered
`name` and the job's `def.name` — the same strings `kit.describe()` reports):

1. No filter present → `J` runs (normal dispatch; nothing about this spec engages).
2. Filter present, scoped form:
   - `E.name` is a key → `J` runs iff `J.name ∈ selection[E.name]`.
   - `E.name` is NOT a key → every job of `E` is replay-skipped.
3. Filter present, flat form: `J` runs iff `J.name` is in the list (any event).
4. Duplicate job names within one event: selection matches ALL of them (names are the
   identity; if that's too coarse the module should name its jobs distinctly).
5. Jobs named `'anonymous'` (unnamed bare functions) are matchable only by that literal
   string; the Console warns when a selection targets or omits anonymous jobs (§10.6).

Selection affects **job execution only**. Detectors, `prepare`, `resolve`, `respond`, and
all plugins run exactly as normal. `respond` receives the executions including skipped ones;
its `ok` is unchanged in meaning (skipped counts as ok — existing predicate).

### 3.4 Error responses

| Condition | Response | Mechanism |
|---|---|---|
| Malformed / oversized / wrong-typed selection JSON | **400** `invalid x-eventkit-replay-jobs` | `ClientError(400)` thrown from the plugin's `configureInvocation`; the plugin-manager re-throws branded ClientErrors by design (`plugin-manager.ts:196`) and `handle()` maps them to `resolved.error` |
| `requireToken` configured and auth header missing/wrong | **401** | same ClientError path |
| `x-eventkit-replay-jobs` present WITHOUT `x-eventkit-replay-of` | **400** — selection without a replay marker is always an operator mistake | same |
| Function's own auth fails (passphrase/signature) | whatever the function already returns | untouched |
| Directive names unknown events/jobs | **200**, runs nothing for those names | not an error: recorded + warned (§6), visible in the result |

**Invariant (security): the directive only narrows.** No header value can cause a job to run
that dispatch would not have run, alter job input, or bypass verification. Worst-case abuse
by someone who already passes function auth = skipping work, which the invocation record
shows.

---

## 4. Core changes (`src/core/`)

New file `src/core/job-filter.ts` (sibling of `chain-guard.ts`, same pattern):

```ts
/** Well-known request.meta key: invocation-scoped job execution filter. */
export const JOB_FILTER_KEY = 'eventkitJobFilter';

export type JobSelection = Record<string, string[]> | string[];

export interface JobFilter {
  /** Parsed selection (§3.2/§3.3). */
  only: JobSelection;
  /** Recorded on each skipped execution. Default: 'rerun job not selected'. */
  reason?: string;
  /** Original invocation id when the filter came from a replay directive. */
  replayOf?: string;
}

/** Pure matcher used by the runtime (and unit-testable in isolation). */
export function jobSelected(filter: JobFilter, eventName: string, jobName: string): boolean;
```

- Exported from `core/index.ts` alongside `SUPPRESS_DISPATCH_KEY`.
- `jobSelected` implements §3.3 rules 2–3. ~15 lines, no deps.
- **Placement decision:** the filter rides `RequestContext.meta[JOB_FILTER_KEY]`, NOT
  `envelope.meta`. Rationale: (a) it is request-channel control state, derived from HTTP
  headers the platforms already normalize onto `request.meta`; (b) a plugin can contribute
  it cleanly via `configureInvocation` (which sees the request; `augmentEnvelope` does not);
  (c) observability serializes `request.meta` wholesale into `invocations.context_data`, so
  the filter + replay marker are recorded with zero sink changes. The suppress-dispatch key
  stays on `envelope.meta` because it derives from envelope content; the two keys' different
  homes are both principled.

No change to `JobExecutionStatus` — `'skipped'` already exists (`core/job.ts`). This spec
makes the runtime its first producer and RESERVES it for framework-level non-execution
(operator selection now; potential future framework gates). `ctx.skip()` keeps producing
`'completed'` + `metadata.conditionNotMet` — the job's own choice. That pair is API.

### 4.1 The `replaySafe` declaration (`JobOptions`)

Jobs declare their rerun safety in the `job(fn, options)` second param:

```ts
export interface JobOptions<TInput = undefined> {
  // …existing fields…
  /**
   * Is this job safe to rerun against the same event?
   *   true      — idempotent / harmless to repeat (status syncs, timeline stamps, lookups)
   *   false     — repeating it can do damage (charges, vendor bookings, outbound emails)
   *   undefined — undeclared (the default); consumers treat it as "unknown, be cautious"
   */
  replaySafe?: boolean;
}
```

```ts
job(stampTimeline, { name: 'stampTimeline', replaySafe: true })
job(callRide,      { name: 'callRide',      replaySafe: false })   // books a real vendor ride
job(writeAuditRow)                                                  // undeclared → unknown
```

Like every `JobOptions` property, `replaySafe` is also declarable on the job module itself
(ADR-043): `defineJob(fn, { name: 'callRide', replaySafe: false })` attaches the config to
the exported function, and a call-site `job(callRide, { replaySafe: true })` overrides it
per the standard precedence (call site wins per property). The module declaration is the
recommended home — rerun safety is a fact about the job's side effects, and it belongs in
the job's own file.

Normative semantics:
- **Descriptive, not enforcing.** In this spec's scope the flag never changes runtime
  behavior — a selected job runs whether or not it is `replaySafe: false`. The operator, via
  the Console's warnings (§10.5a), is the enforcement point. (Optional runtime enforcement —
  a config that hard-skips unsafe jobs on replays — stays a P3 extension, §13.)
- **Tri-state on purpose.** `undefined` is meaningful: most existing jobs won't declare
  anything, and the Console must distinguish "declared safe" (no warning at all) from
  "nobody has said" (mild caution). A required boolean would erase that.
- **Job-level, not module-level.** Rerun safety is a property of the job's side effects; a
  module can hold one safe and one unsafe job. No module-level default (revisit if the
  boilerplate ever hurts).

The declaration reaches consumers over two existing channels, no new surface:
- **`kit.describe()`** — `KitJobDescription` gains `replaySafe?: boolean` (alongside
  `retries`/`timeoutMs`/`tags`), so flow docs and the Expected side of the Console see it
  statically.
- **Observability** — persisted per execution into `job_executions.job_options` (§7), so
  the Console's replay modal reads it off the ORIGINAL invocation's recorded rows. This is
  the channel that matters at replay time, and it is honest by construction: it reflects the
  declaration as of the code version that actually ran, not whatever is on main today.
  `replaySafe` becomes a documented reserved key inside `job_options` (a user metadata key
  with the same name is overwritten — acceptable, documented).

---

## 5. Runtime changes (`src/runtime/run.ts`)

In `runOne`, after the job context is built and plugin contributions collected, BEFORE the
`signal.aborted` check and `onJobStart`:

```ts
const filter = (rt.invocation.request.meta as Record<string, unknown> | undefined)
  ?.[JOB_FILTER_KEY] as JobFilter | undefined;
if (filter && !jobSelected(filter, String(event.name), String(jobName))) {
  const reason = filter.reason ?? 'rerun job not selected';
  await pluginManager.onJobStart(ctx);
  const exec = finish(base, 'skipped', { attempt: 1, startedAt, start });
  exec.metadata = { ...exec.metadata, skipped: { reason, ...(filter.replayOf ? { replayOf: filter.replayOf } : {}) } };
  await pluginManager.onJobEnd(ctx, exec);
  return exec;
}
```

Normative semantics:
- **Both job hooks fire.** The observability plugin creates the row in `onJobStart` and
  finalizes it in `onJobEnd` (`observability/index.ts` requires the start-created record) —
  the visible `⊘` row IS the feature. This deliberately differs from the pre-start
  budget-abort path (`signal.aborted` → `cancelled`, no hooks, no row); keep that contrast
  commented at both sites.
- The job function is never invoked: no retries, no timeout race, no `reportError`.
- `ctx.trackingToken` is still assigned (context construction is unchanged) but nothing
  consumes it — no writes happen.
- Evaluated per (event, job): one invocation detecting several events applies the same
  filter to each with scoped-form semantics.
- Ordering with existing seams: `SUPPRESS_DISPATCH_KEY` (invocation halt) still wins — it
  short-circuits before detection, so the filter never evaluates. Budget abort beats the
  filter only in the sense that a suppressed run does nothing either way; keep the filter
  check first so a replayed invocation under a tight budget still records its skips.
- Lifecycle log line: `emitRunEnd` already renders `⊘` for `'skipped'` (`run.ts:58`). No
  change.

`InvocationResult.ok` and `respond`'s `ok` need no change (skipped already counts ok —
`kit.ts:358`, `:636`).

---

## 6. The `replayControls` plugin (`src/plugins/replay-controls/index.ts`)

Registration: `.use(replayControls)` or `.use(replayControls, { requireToken: '…' })`.

```ts
export interface ReplayControlsConfig {
  /** Require x-eventkit-replay-auth to equal this (constant-time). Default: off. */
  requireToken?: string;
  /** Override the skip reason. Default 'rerun job not selected'. */
  reason?: string;
}
```

Single hook — `configureInvocation(request, envelope)`:

1. Read `request.meta.headers` (lowercased map). No `x-eventkit-replay-of` header → return
   `undefined` (zero cost on normal traffic).
2. If `x-eventkit-replay-jobs` present without `-of` → `throw new ClientError(400, …)`.
3. If `requireToken` set: constant-time compare `x-eventkit-replay-auth`; mismatch →
   `ClientError(401, …)`.
4. Parse selection JSON if present; validate shape (object-of-string-arrays | string-array,
   ≤ 8 KiB, every element a non-empty string). Invalid → `ClientError(400, …)` — never a
   silent full run or full skip.
5. Return the request delta — **spreading the existing meta: `configureInvocation` merges
   SHALLOW (`{...merged, ...partial}`, `plugin-manager.ts:194`), so returning a `meta` key
   replaces `request.meta` wholesale. The plugin must preserve `headers`/`query`/`rawBody`:**

```ts
return {
  meta: {
    ...request.meta,
    [JOB_FILTER_KEY]: only !== undefined
      ? { only, reason, replayOf } satisfies JobFilter
      : undefined,                    // full replay: no filter, marker only
    replay: { of: replayOf, ...(only !== undefined ? { only } : {}) },
  },
};
```

`meta.replay` is the audit marker — persisted automatically inside
`invocations.context_data` (observability serializes `request.meta`). `meta[JOB_FILTER_KEY]`
is the control input the runtime enforces. Two keys, two jobs, one write.

6. Unknown-name diagnostics: the plugin cannot see registered modules from
   `configureInvocation` cheaply, and MUST NOT fail on unknown names (a valid selection for
   module A is "unknown" to a kit that dropped module A last deploy). The Console owns
   pre-flight name validation against `kit.describe()`/recorded rows (§10.6); the runtime
   result makes any mismatch visible (everything skipped).

Why a plugin, not source/core built-in: header parsing is channel knowledge (ADR-039
layering); repos that never replay pay nothing and expose no directive surface unless they
opt in. **A kit without `replayControls` ignores the headers entirely** — the Console must
detect that (§10.7).

---

## 7. Observability changes (`src/plugins/observability/index.ts`)

Two additions:

1. **`onJobEnd` (~3 lines):** merge execution-time metadata into the persisted record, so
   the skip reason (and ADR-035's `conditionNotMet`, which currently falls into the same
   gap) lands in `job_executions.job_options`:

```ts
if (execution.metadata && Object.keys(execution.metadata).length) {
  rec.job_options = safeSerialize({ ...(ctx.job.metadata ?? {}), ...execution.metadata }, serOpts);
}
```

2. **`onJobStart` (~2 lines):** stamp the job's `replaySafe` declaration (§4.1) into the
   record — the plugin already receives `ctx.job.options`:

```ts
const rs = ctx.job.options?.replaySafe;
if (rs !== undefined) rec.job_options = { ...(rec.job_options as object ?? {}), replaySafe: rs };
```

(Undeclared jobs write nothing — absence IS the "unknown" state the Console reads.)

### 7.0 Schema prerequisite: the job-status CHECK constraint (BLOCKING)

`job_options` and `context_data` are jsonb — no change needed there. But `status` is NOT
free: the legacy observability schema constrains `job_executions.status` to
`{running, completed, failed}`, and the graphql sink's default `statusMap`
(`graphql-sink.ts DEFAULT_STATUS_MAP`) therefore folds **`skipped → 'failed'`** (alongside
`timed_out`/`cancelled`). Shipping replay against an unmodified schema would record every
deliberately-skipped job as a FAILURE — the exact opposite of the feature's meaning.

Required, in order:
1. **Widen the CHECK** (additive DDL, safe for legacy writers): `job_executions.status`
   allows at least `skipped` (and, while touching it, `timed_out`, `cancelled`,
   `not_detected` per the console plan's §6 vocabulary work). DDL lives in
   `console/db/schema.sql` (the DDL home per `console-migration-plan.md` §6.2); shared
   environments get it via a **hasura-migrations PR** — never applied directly.
2. **Pass `skipped` through the sink**: once the target schema accepts it, configure
   `graphqlSink({ statusMap: { jobs: { skipped: 'skipped' } } })` (or `mapStatuses: false`
   where the full vocabulary is in). The DEFAULT map stays fold-to-failed so un-migrated
   schemas keep working — the passthrough is a deliberate per-deployment step.
3. The Console renders `'skipped'` per §10.5c (and treats a legacy `failed` row with
   `job_options.skipped` present as a mis-mapped skip from the transition window, if any
   land before 1–2 are sequenced).

### 7.1 Record shapes after a replay (worked example)

Original invocation `A11…` (`ridehail.pending` → `callRide` failed, `notifyDispatch`
completed). Operator replays with selection `{"ridehail.pending":["callRide"]}`.

New invocation `B22…`:

```
invocations B22…
  correlation_id: <same as A11…>            ← re-sent token header (§8)
  source_job_id:  <same parent as A11…>
  context_data: { headers: {...}, rawBody: "…",
                  replay: { of: "A11…", only: {"ridehail.pending":["callRide"]} },
                  eventkitJobFilter: {...} }
  event_executions:
    ridehail.pending (detected)
      job_executions:
        callRide        status: completed   ← actually ran
                        job_options: { replaySafe: false }
        notifyDispatch  status: skipped     job_options: { replaySafe: true, skipped: { reason: "rerun job not selected", replayOf: "A11…" } }
```

Any other module that detects on the replayed payload appears with all jobs skipped —
faithful record of what WOULD have fired.

---

## 8. Lineage

- **Default: rejoin the chain.** The Console re-sends the original inbound tracking-token
  header (recoverable from `context_data.headers` / session variables). Loop-guard lifts it
  exactly as the original did → same correlation id, same `source_job_id` parent → the
  replay renders as the original's **sibling**, distinguished by `context_data.replay`.
- Chained writes by the rerun jobs mint fresh downstream lineage normally, all under the one
  correlation id.
- **Hop depth:** the replay is one hop deeper than the original's inbound token implies. A
  chain at `haltAtDepth` will refuse the replay (suppress-dispatch) — correct by default.
- **Fallback: replay as fresh root.** Console option that omits the token header. New
  correlation id; `context_data.replay.of` still links the audit trail. For halted chains
  and deliberate re-roots.

---

## 9. Security model

1. **Narrowing invariant** (§3.4) — the directive cannot add, reorder, reconfigure, or
   re-input jobs, and cannot bypass `verify`/`rejectUnverified`/`before` guards or the
   suppress-dispatch seam.
2. **Auth unchanged** — the re-POST must pass the function's existing auth. `requireToken`
   is an optional second factor for repos whose function auth is broad.
3. **Signature honesty** — webhook replays re-present the vendor's original signature over
   the original bytes; verification runs for real. No stored `rawBody` → the Console
   disables replay for that invocation (§10.6) instead of sending a doomed request.
4. **Secret custody** — function credentials live in the Console's server-side config
   (§10.2), never in the browser bundle. Related pre-existing finding (not a prerequisite):
   `context_data` stores inbound auth headers verbatim because `request.meta.headers` is
   serialized wholesale; the observability plugin should grow a header-redaction allowlist.
   Tracked separately.

---

## 10. Console changes

Target app: **`console/` in this repo** (EventKit Console — migrated from
`hasura-event-detector/packages/console` per `console-migration-plan.md`; React 18 + Vite +
Tailwind + Apollo + React Flow, deployed as a Netlify site with `netlify/functions/` for
anything that holds a secret). Component names below carry over from the ported app
(`console/src/components/…`); verify paths against the tree at implementation time — the
console is under active development (flow playback, Expected/Compare shipped 2026-07-02).

### 10.1 Architecture: the replay relay

The browser cannot POST to function endpoints directly (cross-origin; no CORS on webhook/db
functions; function secrets must not reach the browser — console plan S1/S3). Precedent
already established: the **Grafana Netlify-function proxy** (`console/netlify/functions/`,
the B1/S3 fix). Add a sibling **`replay.ts` Netlify function** serving `POST /api/replay`
(redirect in `console/netlify.toml`), with Vite dev-proxy parity for local development —
exactly the grafana-proxy pattern.

Request (browser → relay):

```json
{
  "target": "db-ridehails-background",          // source_function, NOT a URL
  "invocationId": "A11…",
  "selection": {"ridehail.pending": ["callRide"]} | null,
  "freshRoot": false
}
```

Relay behavior (server-side, ~120 lines):
1. Resolve `target` against config (§10.2): unknown function → 400 with the configured
   function list. **The browser never supplies a URL** — the relay only POSTs to allowlisted
   endpoints (no SSRF surface).
2. Fetch the invocation row (id, `source_event_payload`, `context_data`) via the configured
   Hasura connection — server-side, reusing the console's existing Hasura credentials.
3. Compose the POST: body = recorded `context_data.rawBody` if present else
   `JSON.stringify(source_event_payload)`; headers = allowlisted originals (§10.4) +
   configured function auth + directive headers + (unless `freshRoot`) the original token
   header.
4. Send; return `{ status, body, invocationId? }` to the browser (parse the function's
   response for the new invocation id when the platform returns one; else the Console
   locates the new invocation by `context_data.replay.of` — §10.5).

### 10.2 Config (server-side env — the console plan killed `console.config.js` for secrets, S2)

The relay function reads its allowlist + credentials from environment variables (Netlify UI
in deployments, `.env` locally, documented in `console/.env.example`):

```
# JSON allowlist: source_function → { url, headers }
REPLAY_FUNCTIONS='{
  "db-ridehails-background": {
    "url": "https://rides-test.hopdrive.io/v1/db-ridehails-background",
    "headers": { "passphrase": "<HOPDRIVE_EVENT_SECRET>" }
  },
  "webhook-handler-uber-updates": {
    "url": "https://rides-test.hopdrive.io/v1/webhook-handler-uber-updates",
    "headers": {}
  }
}'
# Optional: forwarded as x-eventkit-replay-auth when the kit sets requireToken.
REPLAY_AUTH_TOKEN=…
# Hasura access for fetching the recorded invocation server-side (reuses the
# console's existing server-side GraphQL credentials/proxy arrangement, D-CON-1/2).
```

Webhook functions carry no configured auth header — their auth IS the replayed vendor
signature. Function auth headers come from env, never from the stored record (a rotated
passphrase must not resurrect from old rows).

### 10.3 Data layer

`console/src/graphql/queries/invocations.gql` already fetches everything needed
(`source_event_payload`, `context_data`, `event_executions.job_executions { status,
job_options }`). One addition: a lightweight `ReplayLocate` query — invocations where
`context_data.replay.of = $id`, newest first — for post-replay navigation and for the
"replays of this invocation" list. (Hasura jsonb path filter; already expressible against
the existing schema.)

Run `npm run codegen` after the `.gql` change (typed hooks are generated).

### 10.4 Header allowlist (relay-side constant)

Forward from `context_data.headers`: `content-type`, `x-hasura-*` (session-variable channel,
incl. the tracking token unless `freshRoot`), vendor signature/event headers
(`x-uber-*`, `x-lyft-*`, `x-partnerco-*`, `stripe-signature` — configurable list). Drop
everything else (host, connection, content-length — recomputed, cookies, cdn/infra headers).
Function auth headers come from config, never from the stored record (a rotated passphrase
must not resurrect from old rows).

### 10.5 UI: components and changes

**(a) `ReplayModal.tsx` — new component (~250 lines), the heart of the feature.**

```
┌─ Replay invocation A11… ────────────────────────────────────────────┐
│ db-ridehails-background · recorded 2026-07-03 14:12 (3h ago)        │
│                                                                     │
│ Select jobs to rerun — everything unchecked is recorded as          │
│ ⊘ skipped: "rerun job not selected"                                 │
│                                                                     │
│  ▾ ridehail.pending                    (detected in original)       │
│     [x] callRide            ✗ failed 3,412ms      🛑 not rerun-safe │
│        └ ⚠ This job is declared NOT safe to rerun (it may repeat    │
│           real side effects, e.g. book another vendor ride).        │
│           [ ] I understand — rerun it anyway                        │
│     [ ] notifyDispatch      ✓ completed 89ms      ✅ rerun-safe     │
│  ▾ ridehail.audit                                                   │
│     [ ] writeAuditRow       ✓ completed 41ms      · safety unknown  │
│                                                                     │
│  ⚠ callRide previously failed — that's usually what you want.      │
│  ⚠ per checked job with unknown safety that previously succeeded:   │
│     "may repeat its side effects"                                   │
│                                                                     │
│  ▸ Advanced                                                         │
│     ( ) Rejoin original chain (default — same correlation id)       │
│     ( ) Replay as fresh root (new correlation id; use for halted    │
│         chains)                                                     │
│     Preview: POST db-ridehails-background                           │
│       x-eventkit-replay-of: A11…                                    │
│       x-eventkit-replay-jobs: {"ridehail.pending":["callRide"]}     │
│                                                                     │
│  Payload is 3h old — detectors will see the RECORDED row state.     │
│                                                          [Cancel]   │
│                                              [Replay 1 of 3 jobs]   │
└─────────────────────────────────────────────────────────────────────┘
```

Behavior spec:
- Job tree built from the original's `event_executions` (detected ones) +
  `job_executions`; **failed/timed_out/cancelled jobs pre-checked**, others unchecked —
  EXCEPT jobs with `job_options.replaySafe === false`, which are **never pre-checked**,
  even when they failed (a failed unsafe job may have partially executed; the operator
  opts in explicitly).
- **Per-row safety badge**, read from the original run's `job_options.replaySafe`:
  `✅ rerun-safe` (true) · `🛑 not rerun-safe` (false) · `· safety unknown` (absent).
- **Warning ladder** (per checked job):
  - `replaySafe: false` → blocking inline acknowledgment ("I understand — rerun it
    anyway"); Submit stays disabled until every checked-unsafe row is acknowledged.
  - `replaySafe` absent AND the job previously succeeded → non-blocking warning
    ("may repeat its side effects").
  - `replaySafe: true` → no warning, even when it previously succeeded. Declared safety
    silences the caution — that is the point of declaring it.
- Submit button reflects the ladder: `Replay 1 of 3 jobs` normally,
  `Replay 1 of 3 jobs (1 unsafe)` once an unsafe row is checked and acknowledged.
- Submit → `POST /api/replay`; button shows progress; response states:
  - success → toast "Replayed — invocation B22…" with a **View** action (deep-link;
    falls back to `ReplayLocate` polling for ≤10 s when the function returns no id);
  - 400/401 from the relay or function → error banner with the response body verbatim;
  - relay-disabled / unknown function → §10.7 empty-state instead of the form.
- Modal is presentational: selection state + one mutation hook; all composition lives in
  the relay.

**(b) Entry points.**
- `InvocationDetailDrawer.tsx`: add a `Replay…` button to the header action row (next to
  the existing Grafana logs action, ~line 812 area). Opens `ReplayModal` with the loaded
  invocation.
- `JobDetailDrawer.tsx`: add `Rerun this job…` — opens the modal pre-selected to exactly
  that job (its event scoped-form). This is the one-click "fix the failed job" path. When
  the job's recorded `job_options.replaySafe === false`, the button renders with the 🛑
  affordance and the modal opens with the row checked-but-unacknowledged (the ladder in
  §10.5a still gates Submit). The drawer also shows the safety badge in its detail fields.
- `InvocationsTable.tsx`: row kebab → `Replay…` (same modal, loads detail on open).

**(c) Skipped-status rendering.**
- `nodes/JobNode.tsx`: `statusColors` map (line ~30) gains
  `skipped: { gray palette, ⊘ icon }`; a small `⊘` glyph in the icon cluster (alongside the
  existing ✓/✗/spinner branches at lines ~87–106). Tooltip: the reason from
  `job_options.skipped.reason`.
- `JobDetailDrawer.tsx`: when `status === 'skipped'`, show a callout: "Not run — rerun job
  not selected (replay of A11…)" with a link to the original invocation.
- `InvocationDetailDrawer.tsx` events tree (`EventTreeNode`, line ~118): render ⊘ rows
  dimmed with the reason inline.

**(d) Replay provenance badges.**
- `InvocationDetailDrawer.tsx` summary tab: when `context_data.replay` exists, a banner
  chip `↻ Replay of A11…` linking to the original; conversely a `Replays (n)` section on
  the original (from `ReplayLocate`).
- `nodes/InvocationNode.tsx` + `InvocationsTable.tsx`: small `↻` badge when
  `context_data.replay` is present, so replays are distinguishable in the tree/table at a
  glance.
- `FlowDiagram.tsx`: no layout change — the replay is just another invocation node in the
  correlation view; the badge carries the meaning.

**(e) `Settings.tsx`:** read-only panel showing replay relay status (enabled, configured
function list, auth-token presence) from a new `GET /api/replay/config` (sanitized — names
only, never header values).

### 10.6 Pre-flight validation (Console-owned)

Before enabling Submit, the modal checks and, on failure, disables with a reason:
- invocation has `source_event_payload` (else: "no recorded payload");
- for webhook-source functions (`source_function` matches a configured webhook entry):
  `context_data.rawBody` present (else: "raw body not preserved — signature would fail");
- selection non-empty (zero jobs selected is allowed — it is a valid "detect-only" replay —
  but requires an explicit confirm: "Replay with ALL jobs skipped?");
- every checked `replaySafe: false` job has its inline acknowledgment ticked (§10.5a
  ladder — this is a Submit gate, not just a warning);
- warn (not block) on `'anonymous'` job names in the tree.

### 10.7 Degraded modes

- `replay.enabled: false` or function not in the allowlist → entry points render disabled
  with tooltip "Replay not configured for this function".
- Kit without `replayControls` registered: the function will run ALL jobs and ignore the
  directive. The Console cannot reliably detect this a priori — mitigation: after a
  selective replay, compare the new invocation's job rows; if nothing is `skipped` where
  skips were expected, show a warning on the result toast ("target function ignored the
  selection — is replayControls registered?"). Document the pairing requirement loudly in
  the plugin README.

---

## 11. Consumer-facing docs

- `docs/chained-events.md` gains a short "Replaying an invocation" section (Rob's voice,
  plain sentences, no em dashes) once P1 lands: what replay is, the two headers, the skip
  reason string, and the one rule (replay never bypasses your auth).
- Plugin README section for `replayControls` with the kit registration one-liner and the
  requireToken option.

## 12. Test plan

**Core/runtime (vitest):**
- `jobSelected` matrix: scoped/flat, listed/unlisted event, empty array, duplicate names,
  anonymous, no-filter fast path.
- `runOne` replay-skip: hooks emitted in order, status `'skipped'`, reason + replayOf on
  `exec.metadata`, job fn NOT called, retries not engaged, `ok` true.
- Filter + suppress-dispatch: suppression wins (no job rows at all).
- `respond` receives skipped executions; `ok` semantics unchanged.
- `emitRunEnd` renders `⊘`.

**Plugin:**
- Header parsing: absent (no-op, returns undefined), full-replay (marker, no filter), both
  selection forms, malformed JSON → ClientError 400, jobs-without-of → 400, oversize → 400,
  requireToken mismatch → 401, meta shallow-merge preserves headers/rawBody.
- End-to-end through `kit.handle()` with a fake source: 400 surfaces as
  `resolved.error.status === 400`.

**Observability:**
- Skipped row upserted with `job_options.skipped.reason`; conditionNotMet now persisted too
  (regression test for the ADR-035 gap).
- `replaySafe: true|false` stamped into `job_options` at job start; undeclared writes
  nothing; a user metadata key `replaySafe` is overwritten by the declaration (documented
  reserved-key behavior).
- `describe()` reports `replaySafe` on `KitJobDescription` (and omits it when undeclared).

**Live E2E (local harness, mirrors the chained-events proof):**
1. Run a recorded POC invocation normally; capture its rows.
2. Re-POST via curl with `-of` + selection → assert sibling invocation, same correlation
   id, selected job ran, others `⊘` with reason, `context_data.replay` present.
3. Fresh-root variant → new correlation id, `replay.of` still set.
4. Webhook replay with original signature bytes → verify passes; tampered body → verify
   fails (401 with rejectUnverified).

**Console:** relay route unit tests (allowlist, header composition, no-rawBody fallback);
modal state tests (pre-check logic, zero-selection confirm, degraded modes).

## 13. Implementation phasing

| Phase | Contents | Depends on |
|---|---|---|
| P1 — protocol + runtime | core `job-filter.ts`, `runOne` skip, declarative job config (ADR-043: `defineJob`, `fn.config` merge in `job()`), `JobOptions.replaySafe` + `describe()` field, obs metadata + replaySafe persist, `replayControls` + tests, **local schema CHECK widening (`console/db/schema.sql`) + sink `statusMap` passthrough**, curl E2E | nothing |
| P2 — console | hasura-migrations PR for the CHECK widening in shared envs; relay Netlify function + env config, ReplayModal (incl. the replaySafe warning ladder), entry points, ⊘ rendering, badges, ReplayLocate, Settings panel | P1 deployed to the target env; CHECK PR applied |
| P3 — rails | optional runtime ENFORCEMENT of the declaration: `replayControls({ unsafeJobs: 'skip' })` hard-skips `replaySafe: false` jobs on any filtered replay (skip reason `job declared not rerun-safe`), for repos that don't trust operator acknowledgment alone; header-redaction option in observability; matcher class `replay_not_selected` for Compare mode | P2; Compare mode work |

(The earlier sketch of a separate `job(fn, { replay: 'deny' \| 'confirm' })` enum is
superseded by `replaySafe` (§4.1): 'confirm' IS the Console's acknowledgment ladder on
`replaySafe: false`, and 'deny' becomes the kit-level P3 enforcement option above — the
declaration stays a single boolean fact about the job, and policy lives with whoever
consumes it.)

## 14. Decisions to ratify in the register (carried from `selective-replay.md` §10)

- D-a `'skipped'` = framework-level non-execution only; `ctx.skip()` stays
  `'completed'`+conditionNotMet. The pair is API.
- D-b Directive rides `x-eventkit-*` headers over a byte-identical re-POST; body never
  wrapped; auth never bypassed; selection only narrows.
- D-c Replays rejoin lineage via the re-sent original token (sibling, same correlation id),
  marked `context_data.replay`; fresh-root is the explicit fallback.
- D-d Malformed directives → ClientError 400; never silent full-run/full-skip.
- D-e (new, this spec) The filter lives on `request.meta[JOB_FILTER_KEY]` (request-channel
  control state), not `envelope.meta`; contributed via `configureInvocation`.
- D-f (new, this spec) The Console relay only POSTs to config-allowlisted function
  endpoints; the browser never supplies URLs or credentials.
- D-g (new, this spec) `JobOptions.replaySafe?: boolean` is a tri-state DECLARATION
  (safe / unsafe / undeclared), persisted per execution into `job_options` and reported by
  `describe()`. In P1/P2 it is advisory — the Console's warning ladder (no warning /
  caution / blocking acknowledgment) is the enforcement point; runtime enforcement is a
  separate opt-in (P3).
