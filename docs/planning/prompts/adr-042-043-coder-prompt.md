# Coder prompt: implement ADR-042 (selective replay, P1) + ADR-043 (declarative job config)

You are implementing two ratified ADRs in the eventkit repo (`/Users/robnewton/Github/eventkit`).
Read these FIRST, in this order — they are the contract, this prompt is the work order:

1. `docs/planning/selective-replay-spec.md` — the full design spec (wire protocol, runtime
   semantics, observability, schema prerequisite). Sections 3–9 + 12–13 are your scope.
2. `docs/planning/architecture.md` — ADR-042 and ADR-043 (v0.3.24, near the top of §22).
3. `docs/planning/decision-register.md` — D40/D41 for the why.
4. `src/core/chain-guard.ts` + how `SUPPRESS_DISPATCH_KEY` flows through `runtime/kit.ts` —
   the pattern `JOB_FILTER_KEY` mirrors.

## Ground rules (repo conventions — do not deviate)

- Start from **latest `origin/main`** (`git fetch origin && git switch -c feat/adr-042-043-selective-replay origin/main`).
  The local `main` ref may be stale, and the working tree contains other sessions'
  uncommitted changes — do not touch or revert files outside your scope. NEVER commit
  `.obsidian/` or `.claude/`.
- `main` is protected: PR-only. Push over SSH (the PAT lacks workflow scope). Use
  path-limited commits (`git add <specific paths>`).
- Failing tests gate the PR. Run `npm test` and `npm run build` green before pushing.
  There is a coverage ratchet — add tests with your code, don't dilute.
- This repo uses changesets: add one changeset per package-visible change (minor bumps;
  call out the new exports). Pre-1.0, no compat shims needed, but note additions clearly.
- Uncommitted doc updates for this work ALREADY EXIST in the working tree:
  `docs/planning/selective-replay-spec.md`, `docs/planning/selective-replay.md`,
  `docs/planning/architecture.md`, `docs/planning/decision-register.md`,
  `docs/guide.html` (job-options section + a separate in-flight ADR-039 alignment edit —
  both are intentional). Commit them as a `docs:` commit in your PR; do not rewrite them.
  If implementation forces a spec deviation, UPDATE the spec in the same PR and say so in
  the PR description.

## Work items

### A. ADR-043 — declarative job config (do this first; B depends on it)

`src/core/job.ts`:
1. Add `replaySafe?: boolean` to `JobOptions` with the tri-state doc comment from spec §4.1.
2. Add `ConfiguredJobFunction<TInput, TResult>` (a `JobFunction` with an optional
   `config?: JobOptions<TInput>` property) and `defineJob(fn, config?)` — attaches config,
   returns the SAME function, fully typed on `TInput`. Export both from `core/index.ts`.
3. Merge in `job(fn, options?)`: `resolved = { ...fn.config, ...definedProps(options) }`
   where `definedProps` drops `undefined`-VALUED keys (an explicitly-undefined call-site
   key counts as not passed — spread would otherwise clobber module config). Per-property
   shallow; no deep merge of `metadata`/`input`. Name: `resolved.name || fn.name || 'anonymous'`.
4. Extend the ADR-031 banned-key guard: `registerEvent`'s check must reject
   `continueOnFailure` arriving via `fn.config` too (it checks the merged `def.options`,
   so verify that path covers it and add a test).
5. `describe()` (`runtime/kit.ts`): `KitJobDescription` gains `replaySafe?: boolean`
   (omit when undeclared). It already reads merged options — verify, don't assume.

Tests (`src/core/__tests__/` + runtime tests): merge matrix (module-only, call-site-only,
both with override, undefined-valued call-site key, metadata replacement not deep-merge),
name resolution order, bare-fn-in-jobs-array picks up `fn.config` (the auto-wrap path),
banned key via config throws at register, describe() reflects merged + replaySafe.

### B. ADR-042 — selective replay P1

1. **`src/core/job-filter.ts`** (new, mirrors `chain-guard.ts`): `JOB_FILTER_KEY`
   (`'eventkitJobFilter'`), `JobSelection`, `JobFilter`, pure `jobSelected(filter, eventName, jobName)`
   implementing spec §3.3 exactly (scoped + flat forms, unlisted event ⇒ all skipped,
   empty array ⇒ all skipped). Export from `core/index.ts`.
2. **`src/runtime/run.ts`**: in `runOne`, after context build + contributions, BEFORE the
   `signal.aborted` check: read `rt.invocation.request.meta?.[JOB_FILTER_KEY]`; if present
   and the job is not selected, emit `onJobStart`, `finish(base, 'skipped', …)` with
   `exec.metadata.skipped = { reason, replayOf? }` (reason default
   `'rerun job not selected'`), emit `onJobEnd`, return. Job fn NEVER invoked; no retries;
   no reportError. Comment the deliberate contrast with the pre-start budget-abort path
   (which emits no hooks) at both sites.
3. **`src/plugins/replay-controls/index.ts`** (new): `replayControls(config?)` per spec §6.
   Single `configureInvocation(request, envelope)` hook. Fast no-op when no
   `x-eventkit-replay-of` header. `x-eventkit-replay-jobs` without `-of` → ClientError 400.
   `requireToken` mismatch → ClientError 401 (constant-time compare — use
   `timingSafeEqual` via a buffer-length-guarded helper). Selection JSON: validate BOTH
   forms strictly, ≤ 8 KiB, non-empty strings only; invalid → ClientError 400. Return the
   request delta SPREADING `request.meta` (the merge is shallow — preserving
   `headers`/`query`/`rawBody` is load-bearing) with `[JOB_FILTER_KEY]` and
   `replay: { of, only? }`. Export from `plugins` index + package subpath if the plugins
   barrel is subpath-mapped (follow how `correlationResolver` is exported).
4. **Observability** (`src/plugins/observability/index.ts`): (a) `onJobEnd` — when
   `execution.metadata` is non-empty, persist `{ ...ctx.job.metadata, ...execution.metadata }`
   as `job_options` (this also fixes the existing gap where ADR-035 `conditionNotMet`
   reasons were dropped — add the regression test); (b) `onJobStart` — stamp
   `job_options.replaySafe` from `ctx.job.options.replaySafe` when declared.
5. **Sink + schema** (spec §7.0 — BLOCKING for honest records):
   (a) `console/db/schema.sql`: widen the `job_executions.status` CHECK to include
   `skipped` (and `timed_out`, `cancelled`, `not_detected` while you're in there) — DDL
   only in this repo; shared environments are a hasura-migrations PR that is OUT of your
   scope (note it in the PR description as a P2 dependency).
   (b) `graphql-sink.ts`: no default change (the fold-to-failed default protects
   un-migrated schemas). Verify `statusMap: { jobs: { skipped: 'skipped' } }` passes
   through cleanly and add a test proving both the default fold and the passthrough.
6. **Docs**: `docs/chained-events.md` gets the short "Replaying an invocation" section
   (spec §11) — Rob's voice: plain, conversational, short sentences, NO em dashes.
   README/API reference entries for `defineJob`, `replaySafe`, `replayControls`.

Tests: the full spec §12 core/runtime/plugin/observability lists. For the plugin, test
end-to-end through `kit.handle()` with a fake source: a 400 surfaces as
`resolved.error.status === 400`; a valid directive produces skipped rows; NO directive on a
kit WITH the plugin changes nothing (zero-cost path).

### C. Live E2E verification (definition of done)

Use the local harness (see `docs/planning/external-correlation-chaining.md` +
`docs/chained-events.md` for the setup that already exists): local docker Hasura
(`https://gql.local.hopdrive.io/v1/graphql`, admin secret `local-docker-hasura-secret`,
Node clients need `NODE_TLS_REJECT_UNAUTHORIZED=0`), the POC functions in
`/Users/robnewton/Github/event-handlers` (eventkit symlinked — `npm run build` here
propagates), triggers pass header `passphrase: eventkit-local`.

1. Register `replayControls` on the `db-chain-eventkit` POC function; run a normal chain
   invocation; capture its invocation id + inbound token from the observability tables.
2. Re-POST the recorded body via curl with `x-eventkit-replay-of` + a selection choosing
   ONE of the jobs + the original token header. Assert in the DB: new invocation, same
   correlation id, sibling parent, selected job ran, unselected jobs `status='skipped'`
   (schema widened locally first) with `job_options.skipped.reason = 'rerun job not selected'`,
   `context_data.replay.of` set, `context_data.eventkitJobFilter` present.
3. Fresh-root variant (omit token header): new correlation id, `replay.of` still set.
4. Malformed selection → HTTP 400. Full replay (no `-jobs` header) → all jobs run, replay
   marker recorded.
5. Declare `replaySafe` on one POC job (via `defineJob` module config — proving ADR-043
   end to end) and confirm it lands in `job_options.replaySafe`.

Paste the queried DB rows for #2 into the PR description.

## Out of scope (do NOT build)

- Console P2 (relay Netlify function, ReplayModal) — separate effort in `console/`.
- The hasura-migrations PR for shared environments.
- Runtime enforcement of `replaySafe` (`unsafeJobs: 'skip'` — P3).
- Any change to `ctx.skip()` semantics.

## Definition of done

- [ ] A+B implemented per spec; spec updated in-PR if reality forced a deviation
- [ ] All new tests + full suite green; build green; changesets added
- [ ] E2E evidence (C) in the PR description
- [ ] Docs commit includes the pre-authored planning-doc/guide updates
- [ ] PR opened against main (do not merge without review)
