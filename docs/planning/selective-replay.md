# Planning: Selective Replay (rerun chosen jobs of a recorded invocation)

**Status:** superseded for implementation by `selective-replay-spec.md` (the design spec —
exact types, wire grammar, runtime diffs, console UI). This document remains the
exploration/rationale record. Note one design correction made in the spec: the job filter
lives on `request.meta[JOB_FILTER_KEY]` (contributed via `configureInvocation`), not
`envelope.meta` — `augmentEnvelope` cannot see request headers, and `request.meta` is
persisted to `context_data` for free. Companion to `console-expected-flows.md` (the Console
this feature surfaces in) and the Observability records it reads from and writes to.

---

## 1. The idea

An operator looks at a recorded invocation in the Console — say `ridehail.pending` detected,
`callRide` failed, `notifyDispatch` succeeded — and wants to rerun **just `callRide`**,
without re-firing every sibling job and double-sending the dispatch notification. They pick
the jobs to rerun; the replayed invocation runs those and records every unselected job as
`skipped` with reason `rerun job not selected`, so the replay is a complete, honest record —
not a mystery invocation where half the jobs silently vanished.

Two properties define the feature:

- **Replay, not re-evaluation.** The rerun uses the *recorded* payload. If the underlying
  row has changed since, the detectors see the old snapshot. That is the correct semantic
  for "this job failed, run it again" — and it is a different tool from the existing
  "flip the row's status back" replay trick, which re-evaluates *current* state.
- **Selection only narrows.** The directive can only *prevent* jobs from running, never
  conjure jobs the modules didn't declare or widen behavior. Fail-safe by construction:
  the worst a forged directive can do is skip work, and the request still has to pass the
  function's existing auth to be processed at all.

## 2. What the architecture already gives us

This is why the answer to "possible with minor changes?" is **yes**. The exploration found
five pieces that fit as if reserved for this:

1. **`'skipped'` is a first-class job status that nothing produces today.**
   `JobExecutionStatus` includes `'skipped'` (core/job.ts), and BOTH ok-predicates already
   treat it as success (`kit.ts` — `status === 'completed' || status === 'skipped'`, in
   `InvocationResult.ok` and the `respond` seam's `ok`). Meanwhile `ctx.skip(reason)`
   (ADR-035) deliberately ends `'completed'` + `metadata.conditionNotMet` — a job that RAN
   and chose to do nothing. The unclaimed `'skipped'` status is exactly the missing half of
   that pair: a job the FRAMEWORK never ran. Selective replay is its first producer, and the
   distinction stays clean: `completed`+conditionNotMet = the job's choice; `skipped` = the
   operator's choice.

2. **Request headers already reach the runtime on every platform.** All platform adapters
   stash lowercased `headers`, `query`, and (when preserved) `rawBody` onto
   `RequestContext.meta` (`platform-shared.ts requestMeta`). A replay directive carried as
   HTTP headers needs zero platform work.

3. **Observability already stores everything the Console needs to compose a replay.**
   `invocations.source_event_payload` is the original body; `invocations.context_data` is
   `request.meta` — which *includes the original headers and rawBody*. The Console can
   re-POST byte-identical requests from stored data alone.

4. **There is precedent for a core-owned, plugin-set control key on the envelope.**
   `SUPPRESS_DISPATCH_KEY` / `CHAIN_GUARD_WARNING_KEY` (ADR-034/041): a plugin decides
   policy pre-dispatch, sets a well-known `envelope.meta` key, and the runtime enforces it
   at exactly one seam. The job filter is the same shape one level down — invocation-level
   suppression exists; job-level selection is its sibling.

5. **Chain lineage reattaches with zero new mechanism.** The original invocation's inbound
   tracking token is in the stored headers/session variables (`context_data`). If the
   Console re-sends it (`x-hasura-tracking-token` for Hasura functions; the loop-guard
   candidates channel generally), the replayed invocation lifts the same lineage the
   original did — same correlation id, same parent job — and lands in the SAME chain tree,
   as a sibling of the original invocation. No special-case replay lineage code.

Also load-bearing: modules are declarative (ADR-025), so job identity is stable strings
(`event name` + `job name`) that `kit.describe()` already exposes — the selection UI and the
filter speak the same names the runtime dispatches by.

## 3. The wire protocol

Replay = **re-POST the original request to the same function URL**, with the directive in
`x-eventkit-*` headers. The body stays byte-identical to the recorded one (this matters —
§8.2). Proposed headers:

| Header | Value | Purpose |
|---|---|---|
| `x-eventkit-replay-of` | original invocation id | marks this as a replay; audit link |
| `x-eventkit-replay-jobs` | JSON selection (below) | which jobs RUN; everything else skips |

Selection shape — explicit about events so two modules with a same-named job can't collide,
with a flat convenience form:

```json
{"ridehail.pending": ["callRide"]}          // per event: run ONLY these jobs
["callRide"]                                 // flat: run jobs with these names, any event
```

Semantics:
- An event listed with a job array: its listed jobs run; its unlisted jobs skip.
- An event NOT listed (or none of its jobs named in the flat form): ALL its jobs skip.
  Detection still runs and is recorded — the replay shows what WOULD have fired, skipped.
- No `x-eventkit-replay-jobs` header but `x-eventkit-replay-of` present: full replay
  (all jobs run) — still marked as a replay in the record.
- Selection never affects detectors, `prepare`, `resolve`/`respond`, or plugins. It gates
  job execution only. (A module whose `respond` reads job results sees the skipped
  executions — `ok` stays true, statuses are visible. Honest.)

Why headers and not a body wrapper: the body must stay the source's native payload so
`normalize` is untouched (a Hasura event body is Hasura's shape; wrapping it would need
source-by-source unwrap logic and would break byte-exact webhook signature re-verification).
Headers are already the kit's control channel (passphrase, tokens, session variables).

Auth is unchanged: the replayed POST must satisfy whatever the function already requires
(passphrase `before` guard, webhook signature, etc.). The directive grants nothing.

## 4. Inside the runtime

### 4.1 The seam: a well-known job-filter meta key

Mirroring the chain-guard keys, core defines:

```
JOB_FILTER_KEY  → envelope.meta['eventkitJobFilter'] : {
  only: Record<string, string[]> | string[],   // parsed selection (§3)
  reason?: string,                              // default: 'rerun job not selected'
  replayOf?: string,                            // original invocation id (audit)
}
```

Anyone may set it (the replay plugin in §5 is the intended writer; a test harness or an
exotic source could too). Core owns the key + types; the runtime owns enforcement.

### 4.2 Enforcement in the executor (~15 lines)

In `run.ts runOne`, before `pluginManager.onJobStart` — after the context is built, so the
skip is a fully-formed record:

- If `envelope.meta[JOB_FILTER_KEY]` exists and this `(event.name, def.name)` is NOT
  selected → `finish(base, 'skipped', …)` with the reason recorded on the execution
  (mirroring the conditionNotMet shape: `exec.metadata.skipped = { reason }`), emit
  `onJobStart` + `onJobEnd` around it so observability writes the row, and return. No job
  fn call, no retries, no token minting side effects beyond context construction.

Nothing else in the runtime changes. Points that fall out for free:

- `InvocationResult.ok` already counts `skipped` as ok — a replay with 1 run + 4 skipped
  jobs returns 200, no vendor/Hasura retry.
- Retries (`maxAttempts`) never engage for a skipped job (we return before the loop's work).
- The suppress-dispatch seam still outranks this: a loop-guard halt suppresses everything,
  filter or not. (A replay re-sending the original token is one hop deeper — see §8.4.)
- `dryRun()` needs no change; the Console can still preview detection without dispatch.

One deliberate contrast to note in review: the existing pre-start budget-abort path
(`signal.aborted` → `cancelled`) returns WITHOUT emitting job hooks, so cancelled-before-
start jobs leave no observability row today. Replay-skip must emit the hooks — the visible
`⊘` row IS the feature. Keep the two paths' difference intentional and commented.

### 4.3 Observability delta (~2 lines)

`onJobEnd` currently persists status/duration/output/error but ignores
`execution.metadata` — the skip reason would be dropped. Smallest change: in
`observability.onJobEnd`, when `execution.metadata` differs from the definition metadata,
merge it into the record's `job_options` (this also fixes a latent gap: ADR-035's
`conditionNotMet` reason currently reaches `job_options` only via the same hole). Status
`'skipped'` itself needs no schema change — `job_executions.status` is a text column.

## 5. The `replayControls` plugin (~80 lines, ships with core plugins)

The header-to-meta bridge, deliberately dumb:

- `augmentEnvelope(envelope)`: read `request.meta.headers['x-eventkit-replay-of' / '-jobs']`
  (headers are on the envelope's request context via `configureInvocation` — or read them in
  that hook and stamp the envelope there; implementation picks the cleaner of the two).
  Parse + validate the JSON (malformed → reject loudly with a ClientError 400: a garbled
  directive must never degrade into "ran everything" OR "skipped everything" silently).
  Set `envelope.meta[JOB_FILTER_KEY]` and `meta.replayOf`.
- Stamp the replay marker for the record: `request.meta.replay = { of, only }` — which
  observability already persists verbatim inside `context_data` (it serializes
  `request.meta`). The Console gets its "replay of #X" badge with no sink change.
- Optionally validate job names against `kit.describe()` and log unknown names (typo'd
  selection = everything skips; a warn makes that debuggable).

Config surface (small): `{ header?: string, requireToken?: string }` — the latter an
optional shared secret (`x-eventkit-replay-auth`) for repos that want replay gated
separately from the function's own auth. Default off; the skip-only design keeps the risk
profile low without it.

Why a plugin and not source/core built-in: same layering as ADR-039 — reading HTTP headers
is channel knowledge, and repos that never replay shouldn't parse for it. The runtime seam
(§4) is core; the wire adapter is opt-in.

## 6. Lineage and what the records look like

The Console replays with the original inbound token header re-attached (§2.5), so:

- **Same correlation id** — the replay joins the original chain tree.
- **Same parent** (`source_job_id`) as the original invocation — the replay renders as the
  original's *sibling*, distinguished by `context_data.replay.of = <original invocation id>`.
  This is the honest shape: the replay was caused by the same upstream write, re-presented.
- Chained writes made by the rerun jobs mint fresh downstream lineage as normal — a replay
  that fixes `callRide` produces its own booking → webhook → update chain, all under the one
  correlation id.

A replayed invocation's job rows:

| job | status | note |
|---|---|---|
| `callRide` | `completed` (or `failed` — it really ran) | normal execution record |
| `notifyDispatch` | `skipped` | `job_options.skipped.reason: "rerun job not selected"` |

And for modules that detected but had nothing selected: detection recorded, every job
`skipped`. Nothing about the replay is inferred — it is all first-class rows.

## 7. Console interaction (builds on `console-expected-flows.md` Observed mode)

### 7.1 Entry points

- Invocation detail view → **Replay** button.
- A failed job's row/chip → **Rerun this job** (pre-selects just it).
- (Later) correlation-tree view → replay any node in the chain.

### 7.2 The selection modal

- Lists the invocation's detected events and their jobs with status icons from the original
  run. Checkboxes per job; **failed/timed-out jobs pre-checked**, succeeded jobs unchecked.
- Inline warning when a checked job succeeded originally: "this job already completed —
  rerunning may repeat its side effects." (See §8.1 for the harder version.)
- Shows what will be sent: target function, `replay-of` id, the selection JSON. No hidden
  composition.

### 7.3 What the Console composes

From stored observability data alone:

1. **Body**: `source_event_payload` — for webhook sources prefer the stored `rawBody`
   (byte-exact, §8.2).
2. **Headers**: the stored `context_data.headers`, filtered through an allowlist (drop
   hop-by-hop/infra headers; keep content-type, the source's auth headers, session-variable
   token headers). Plus the directive headers (§3). Plus the original inbound tracking-token
   header so lineage reattaches (§6).
3. **Target**: the function URL derived from `source_function` + the environment the Console
   is pointed at.

Security note that falls out of this exploration and deserves its own look regardless of
replay: `context_data` already stores inbound auth headers (e.g. the Hasura passphrase)
verbatim, because `request.meta.headers` is serialized wholesale. The Console SHOULD source
function credentials from its own config, and the observability plugin should probably grow
a header-redaction option — tracked as a separate finding, not a replay prerequisite.

### 7.4 After the POST

- The response's `invocationId` links straight to the new record.
- The new invocation appears in the same correlation tree with a **"replay of #original"**
  badge (from `context_data.replay`), selected jobs showing real outcomes, unselected
  showing `⊘ skipped — rerun job not selected`.
- Compare mode (`console-expected-flows.md` §3): replay-skipped jobs need their own matcher
  classification — proposal: `replay_not_selected`, rendered like `optional_not_taken` but
  visually distinct — so a replay overlaid on the expected flow doesn't read as a broken
  run. Replayed invocations should also be excludable from conformance views by the
  `context_data.replay` marker.

## 8. Safety rails and open questions

**8.1 Non-idempotent jobs.** Rerunning `chargeCustomer` is not like rerunning
`stampTimeline`. Proposal (phase 2): `job(fn, { replay: 'deny' | 'confirm' })` — `deny`
makes the runtime skip it on ANY filtered replay with reason `job opted out of replay`;
`confirm` makes the Console require an extra acknowledgment. Default stays permissive
(`allow`) — the operator is trusted; the rail is opt-in per dangerous job.

**8.2 Webhook signature re-verification.** A replayed webhook re-presents the vendor's
original signature. It verifies IFF the body bytes are exact — hence rawBody storage and
byte-identical re-POST. This is a feature, not a problem: replay does not and must not
bypass `verify`/`rejectUnverified`. If the raw bytes weren't preserved for an old
invocation, the Console disables replay for it (visible reason) rather than sending a
request that will 401.

**8.3 Stale payloads.** The recorded payload may describe a row that has since moved on.
That is inherent to replay and usually wanted (rerun what failed, as it was). The modal
should show the payload age; for "re-evaluate the row as it is NOW", the existing
status-flip replay (detectors matching UPDATE→'new' etc.) remains the right tool. The two
are complementary and the Console can eventually offer both verbs.

**8.4 Hop depth.** Re-sending the original token makes the replay one hop deeper than the
original invocation (loop-guard increments per hop). Harmless at sane ceilings, but a chain
already AT `haltAtDepth` will refuse a replay (suppress-dispatch). That is arguably correct;
if it bites operators, the Console can offer "replay as fresh root" (omit the token header)
as an explicit fallback — the record still carries `replay.of` for audit.

**8.5 Replay of a replay.** Nothing prevents it; `replay.of` chains give the audit trail.
No special handling proposed.

**8.6 Naming.** "Selective replay" for the feature; job-level reason string exactly
`rerun job not selected` (Rob's phrasing) — it reads correctly in a job row without context.

## 9. Change inventory (the "minor changes" verdict)

| Piece | Where | Size | Notes |
|---|---|---|---|
| `JOB_FILTER_KEY` + filter types | core (chain-guard.ts sibling or own file) | ~25 lines | mirrors SUPPRESS_DISPATCH_KEY pattern |
| Pre-execution filter check → `'skipped'` | runtime `run.ts runOne` | ~15 lines | emits onJobStart/onJobEnd; first producer of `'skipped'` |
| Persist `execution.metadata` on job end | observability plugin | ~3 lines | also fixes ADR-035 reason gap |
| `replayControls()` plugin | plugins | ~80 lines + tests | header parse/validate, meta stamping, ClientError 400 on garbage |
| Matcher class `replay_not_selected` | console/matcher (planned code) | small | lands with Compare mode work |
| Console: selection modal + composer + badges | console app | the real work | Observed mode feature; needs stored rawBody/header allowlist |
| `job(fn, { replay })` rail | core + runtime | ~20 lines | phase 2 |

Runtime + plugin side is a day-scale change with tests; the Console UX is where the effort
lives, and it stacks cleanly on the already-planned Observed mode rather than needing new
backend surface (everything it reads is already recorded).

Suggested phasing:
1. **P1 — protocol + runtime**: core key, runOne skip, obs metadata persist,
   `replayControls`, curl-driven E2E on the local harness (replay a recorded POC invocation
   by hand, verify the ⊘ rows and same-tree lineage).
2. **P2 — console**: selection modal, composer, badges, matcher class.
3. **P3 — rails**: `replay: 'deny'|'confirm'`, header redaction option, "replay as fresh
   root".

## 10. Decisions to ratify (candidates for the register when this leaves planning)

- D-a: `'skipped'` status is produced exclusively by framework-level selection (operator
  choice); `ctx.skip()` stays `'completed'`+conditionNotMet (job choice). The pair is the
  API.
- D-b: replay directive rides `x-eventkit-*` headers over a byte-identical re-POST; body is
  never wrapped; auth is never bypassed; selection only narrows.
- D-c: replayed invocations reattach lineage via the re-sent original token (sibling of the
  original, same correlation id), marked `context_data.replay = { of, only }`.
- D-d: malformed directives reject with ClientError 400 — never a silent full run or full
  skip.
