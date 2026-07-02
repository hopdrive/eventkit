# EventKit Console — Migration & Improvement Plan

**Status:** approved plan, implementation in progress
**Date:** 2026-07-01
**Owner:** Rob Newton · drafted by Claude
**Relates to:** `console-expected-flows.md` (the Console's Expected/Compare future), `architecture.md` §16, ADR-032, D9.

The interactive observability console currently lives in `hasura-event-detector/packages/console`. The Observability plugin it fronts now ships in this repo, so the console moves here too, gets a deployment story (Netlify + GitHub Actions), and gets the bug/perf/UX overhaul it needs to be the day-to-day lens on HopDrive's event platform. This document records the audit of the existing console, the target architecture in this repo, and a phased implementation plan.

---

## 1. What the console is today

Vite + React 18 SPA (`packages/console` in the legacy repo): Apollo Client → Hasura → the observability database (`event_detector_observability`; tables `invocations` / `event_executions` / `job_executions`). Pages: **Overview** (KPIs + activity chart), **Invocations** (table), **Flow** (React Flow tree for one invocation's correlation chain), **Analytics** (aggregates + recent failures), **Settings**. Detail drawers for invocation/event/job/undetected-events; a Grafana Loki log viewer; correlation search in the header.

**Schema continuity is already solved:** eventkit's `graphql-sink` upserts into the *same three tables* with the same columns (`graphql-sink.ts` INVOCATION_COLUMNS/EVENT_COLUMNS/JOB_COLUMNS) and maps eventkit statuses onto the legacy CHECK constraints (`mapStatuses`). One console serves both runtimes through the entire migration. The Hasura metadata for the `events` source (relationships `event_executions`, `job_executions`, `correlated_invocations`, `source_job_execution`, `triggered_invocations`) already lives in `hasura-migrations/hasura/metadata/databases/events/`.

## 2. Audit findings

### 2.1 Performance root causes (why it's slow in prod)

| # | Finding | Evidence | Impact |
|---|---|---|---|
| P1 | **Invocations table fetches 1,000 rows with full `source_event_payload` JSONB** + 3 aggregate sub-selects per row, then does *all* filtering/sorting/search/pagination client-side (tanstack `getFilteredRowModel`) | `InvocationsTable.tsx:71` (`limit: 1000`), `invocations.gql` (payload in list query) | Tens of MB per load; DB detoasts 1,000 payloads; UI churns on every keystroke |
| P2 | **Search does `source_event_payload::text ILIKE '%…%'`** (JSONB cast, leading wildcard) across `invocations`, plus `_ilike` on uuid-as-text `correlation_id` | `invocations.gql` CorrelationSearch | Sequential scan + full detoast of every row's payload; this is the "search is slow/unreliable" complaint |
| P3 | **Search fires a query on every keystroke** (≥2 chars) with **no debounce** | `CorrelationSearch.tsx:39-64` | Piles up concurrent scans of P2 under typing |
| P4 | **Overview polls every 5s**, and its `invocations_chart` selects **every invocation row in the time range** (up to 7 days) each poll | `OverviewDashboard.tsx:120`, `dashboard.gql` | At prod volume this is a repeating multi-second query; the 5s cadence stacks |
| P5 | Search "works" only within the 1,000 newest rows on the Invocations page (header search just sets the client-side global filter) | `InvocationsTable.tsx:123-125` | Search *misses older data entirely* → "unreliable" |
| P6 | **ReactFlow remounts on node-count change** (`key={flow-${nodes.length}}`), all edges `animated: true`, positioning hook recomputes per render | `FlowDiagram.tsx:313,329` | Flow page jank on large chains; full re-layout on any data tick |
| P7 | Framer-motion mount animation per table row; no virtualization (tanstack-virtual is a dep but unused) | `InvocationsTable.tsx:545-548` | Paint cost at 100-200 rows/page |
| P8 | Unbounded aggregate `nodes { event_name }` lists in dashboard/analytics queries | `dashboard.gql`, `analytics.gql` | Fetches every event row in range to count names client-side |
| P9 | Bundle: antd + headlessui + heroicons + framer-motion + recharts + reactflow + react-json-tree + jsondiffpatch, no code-splitting, Google Fonts from network | `package.json`, `index.html` | Slow first paint; antd is nearly unused |

### 2.2 Bugs & correctness
- **B1 — Grafana logs are broken in any deployed build**: `LogsViewer` calls `/api/grafana/...`, which only exists as a **Vite dev-server proxy** (`vite.config.ts`). A Netlify build has no proxy → all log fetches 404. Needs a Netlify redirect/function proxy.
- **B2 — `recordId` derivation** `payload.event.data.new.id` breaks for DELETE (no `new`), MANUAL, crons, webhooks, actions (`InvocationsTable.tsx:97`). Same in search suggestions.
- **B3 — jobs with unknown status count as "successful"** in flow summary (`FlowDiagram.tsx:62`), which will misreport eventkit's `cancelled`/`timed_out` (mapped or not).
- **B4 — suggestion click** inserts `correlation_id || user_email || source_function` into a single string filter — clicking a suggestion frequently yields different results than the suggestion showed.
- **B5 — no error boundaries**; one drawer exception whites the app.
- **B6 — stale "running" rows**: legacy flush loss means `running` invocations that died stay `running` forever; UI presents them as live (eventkit sink improves this, but the console should render `running` > N minutes as `stale`).
- **B7 — time-range selector doesn't apply to the Invocations page** (only Overview/Analytics use it).

### 2.3 Security (deployment blockers)
- **S1 — `VITE_HASURA_ADMIN_SECRET` is baked into the client bundle.** Fine on localhost; on Netlify it publishes an **admin secret** to anyone who can read JS. The deployed console MUST NOT ship any admin secret: create a read-only Hasura role (`observability_viewer`) with select-only permissions on the `events`-source tables (via `hasura-migrations` PR — never applied directly), and front the site with auth (see §5).
- **S2 — legacy `console.config.js` contains a hard-coded test admin secret and RDS password** — do not port that file; all config via env.
- **S3 — Grafana Loki credentials** likewise must live server-side (Netlify function proxy), never as `VITE_` vars.

### 2.4 UX gaps (informed by how EventKit is actually used)
- **U1 — search doesn't speak the operator's language.** You cannot search by **event name** (`move.pickup.started`), **job name** (`runARV2`), or **record** (`moves:41885`) except via the payload-cast scan. These, plus correlation id and function, are exactly the five things an on-call engineer greps for.
- **U2 — the chain is the unit of investigation, but the UI is invocation-centric.** `source_job_id` + `correlation_id` already encode parent→child chains (and, with ADR-028, vendor round-trips). There's no "show me this whole chain as a timeline" view — the flow diagram shows one correlation group but entry always starts from an invocation row.
- **U3 — no server-side facets**: status/function/operation/source-system filters exist only as client-side filters over the 1,000-row window.
- **U4 — no deep links** for search/filters (only `/flow?invocationId=`); sharing an investigation means screenshots.
- **U5 — undetected events** (245 detectors × every invocation) dominate the data but the UI only has a hide/show toggle; no per-detector stats ("this detector never fires — dead code?").
- **U6 — no eventkit-vocabulary rendering**: `source_system` (`'hasura'`, `'webhook:stripe'`), cron/action/webhook sources, `resolve`/`respond` outcomes, and `skipped`/`cancelled` job statuses arrive with the migration and need first-class display.
- **U7 — job logs**: neither the legacy plugin nor eventkit's graphql-sink persists per-job logs to the DB (`job_logs` has no writer; JOB_COLUMNS has no logs field). The console's only log source is Grafana Loki. Decision D-CON-4 below.

## 3. Target architecture in this repo

```
eventkit/
  console/                    # standalone Vite app — NOT part of the npm package build
    netlify.toml              # base for the Netlify site (build, publish, redirects, functions)
    netlify/functions/        # grafana-proxy.ts (Loki auth server-side)
    package.json              # own deps/scripts; not a workspace of the library build
    src/                      # ported + refactored app
    db/                       # observability DDL owned here going forward:
      schema.sql              # (imported from legacy model/) + new indexes (§6.2)
      seed/seed.mjs           # perf-scale local seeder (§8)
    codegen.ts, .env.example
  docs/planning/console-migration-plan.md   # this file
  .github/workflows/console-ci.yml           # path-filtered CI/CD (§7)
```

Rules: the root library `package.json`/`tsconfig`/CI stay untouched (test-coverage work is in flight there); `console/**` is path-isolated. The npm package continues to ship no UI. Branding becomes **EventKit Console** (it fronts both runtimes' data).

## 4. Feature & UX plan

### 4.1 Search, rebuilt around the five lookup perspectives (the headline fix)
One search box, server-side, debounced (250ms), each perspective an indexed query — combined via a single Hasura `_or` only where cheap, otherwise run as parallel typed lookups with grouped results:

1. **Correlation id** — exact/prefix on `correlation_id` (uuid = text pattern only when input looks like one).
2. **Event name** — `event_executions.event_name` prefix/trigram match (`move.pickup.%`), grouped to distinct names + recent occurrences. The flow YAML vocabulary means names are dot-hierarchical: support segment search (`*.cancel.*`).
3. **Job name** — `job_executions.job_name` same treatment.
4. **Record** — `table:id` syntax hits a new indexed `source_record_id` column (§6.2), not a payload cast.
5. **Function / source** — `source_function`, `source_system`, `source_user_email` prefix matches.

Results render grouped by perspective ("Chains · Events · Jobs · Records · Functions"), each row deep-linking (`/invocations?q=…&facet=…`, `/chain/:correlationId`). Enter = full results page, not just a dropdown.

### 4.2 Chain view (new page, the eventkit-native centerpiece)
`/chain/:correlationId` — the whole story of one correlation id: a **timeline** (left, ordered invocations with source badges: DB table+op, webhook vendor, cron schedule, action name) and the **flow graph** (right, the existing React Flow tree, upgraded with `dagre`/`elkjs` layout). Parent→child edges from `source_job_id`; vendor round-trips (ADR-028 `correlationResolver`) render as a dashed "vendor hop" edge between the outbound job and the inbound webhook invocation. Node-id scheme follows `console-expected-flows.md` §4 (`event:<name>`, `job:<event>:<job>`) so the Expected/Compare overlay (D9) can land on this same canvas later without rework.

### 4.3 Invocations page
Server-side everything: pagination (`limit/offset` + count), sorting, status/function/operation/source-system/time-range facets as `where` clauses, and the search box driving a server query (P5 fix). Slim list query (no payload, no per-row aggregates — the counters are already denormalized columns: `events_detected_count`, `total_jobs_*`). Row virtualization; no mount animations. "Hide child invocations" becomes a server-side `source_job_id: {_is_null: true}` filter; "hide zero detected" becomes `events_detected_count: {_gt: 0}`.

### 4.4 Overview & Analytics
Replace the fetch-all chart with a **server-side time bucket** (Hasura can't `date_trunc` natively → add a small SQL view/function `invocation_counts_bucketed(range, bucket)` in the observability DB, tracked read-only). Poll at 30s (visible-tab only), pause when hidden, with a manual refresh + a live toggle that switches to a Hasura **subscription** only when the operator opts in. Analytics gains per-event-name and per-job-name failure/duration leaderboards (aggregate queries on indexed names) and a **detector health** panel (fire-rate per event name; "never fires" flags — U5).

### 4.5 Detail drawers & logs
Keep the drawer pattern (it's good); add error boundaries per drawer; `react-json-tree` renders payloads lazily/collapsed. Job drawer adds **checkpoints/progress** when present (eventkit records them) and links "triggered invocations" (via `triggered_invocations` relationship) to walk the chain downward. Logs tab reads Loki through the Netlify function proxy (B1/S3 fix) filtered by `job_execution_id`/`correlation_id` labels — per D-CON-4.

### 4.6 Visual design
Phases 1–3 preserve the current Tailwind look (dark-mode-first, fine for an internal tool) — structural work only. Phase 4 restyle consults the HopDrive design system (`hopdrive-ui:designer`) for tokens/colors so the console reads as a HopDrive tool; drop antd (replace the few usages with headless equivalents) as part of the bundle diet either way.

## 5. Deployment: Netlify + auth

- **Site**: new Netlify site `eventkit-console` (base `console/`, publish `console/dist`, SPA fallback redirect). Functions dir for the Grafana proxy (and, if D-CON-2 lands, a GraphQL proxy).
- **Auth (S1)** — decision **D-CON-1**, recommended shape: Hasura JWT with a dedicated **`observability_viewer` role** (select-only permissions on the five `events`-source tables + the bucketed view; added via `hasura-migrations` PR). The console does Firebase login (same as other internal tools) and sends the JWT; no secret in the bundle at all. Interim (until the PR lands): Netlify site password/basic-auth **plus** a thin Netlify function GraphQL proxy that injects the admin secret server-side and enforces read-only (allowlist: `query` operations on the five types). The interim proxy is throwaway but small.
- **Env vars** (Netlify UI, never committed): `GRAPHQL_ENDPOINT`, `GRAFANA_HOST/ID/SECRET` (functions only); `VITE_GRAPHQL_ENDPOINT` for the client. `.env.example` documents local dev.

## 6. Data layer

### 6.1 One console, both runtimes
No schema fork: the eventkit sink already writes the legacy tables with mapped statuses. The console renders `source_system` and tolerates both vocabularies (`not_detected` etc.). New columns below are additive and nullable, so legacy writers are unaffected.

### 6.2 Observability DB changes (DDL lives in `console/db/`, applied to the events DB; metadata via `hasura-migrations` PR)
- **`invocations.source_record_id text`** — extracted at write time going forward (eventkit sink change: `<table>:<row pk>` for hasura sources; vendor object id for webhooks) **plus** backfill migration for recent history; B-tree index. Kills the payload-cast search.
- **Indexes** (verify against legacy `schema.sql`, add what's missing): `invocations(created_at desc)`, `invocations(correlation_id)`, `invocations(source_function, created_at desc)`, `invocations(status) where status='running'`, `invocations(source_job_id) where source_job_id is not null`, `invocations(source_record_id)`, `event_executions(event_name, created_at desc)`, `event_executions(invocation_id)`, `job_executions(job_name, created_at desc)`, `job_executions(invocation_id)`, `job_executions(status, created_at desc) where status='failed'`. Add `pg_trgm` GIN on `event_name`/`job_name`/`source_function` only if prefix search proves insufficient.
- **`invocation_counts_bucketed`** SQL function/view for the Overview chart (§4.4).
- **Retention**: define a purge policy (e.g., 90d detail, 13mo `metrics_hourly`) — decision D-CON-3; index bloat is the other half of prod slowness and nobody owns deletion today.

## 7. CI/CD (GitHub Actions)

`.github/workflows/console-ci.yml`, path-filtered to `console/**` so library CI is untouched:
- **PR**: install (cached), `tsc --noEmit`, lint, vitest (component/unit), `vite build`, Netlify **preview deploy** (`netlify deploy --dir console/dist --alias pr-<n>`), PR comment with URL. Secrets: `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`.
- **main**: same checks then `netlify deploy --prod`.
- **Verification gate**: a Playwright smoke (build preview served locally in CI): app boots, Invocations renders seeded fixture data via a mocked GraphQL layer, search returns grouped results, chain page renders. Keeps "deploy = verified," not "deploy = compiled."

## 8. Local dev & the perf harness

- **Local wiring** (one-time, scripted in `console/db/local-setup.mjs`): create `event_detector_observability` DB in `hopdrive-postgres`, apply `schema.sql`, then `pg_update_source` the existing (currently-inconsistent) `events` source on local Hasura to a literal local connection string + `reload_metadata`. The repo's metadata (relationships included) then activates as-is. Local admin secret comes from `hasura-migrations/docker-compose.yml` — never committed here.
- **Seeder** (`console/db/seed/seed.mjs`): deterministic, scaled to *beyond* prod shape — default **200k invocations / 800k event_executions / 400k job_executions**, realistic payload JSONB (2–10KB), real event/job name distributions (from `event-handlers`: `move.*`, `appointment.*`, `runAR`, `publishGenericWebhook`, …), 30-day time skew, ~15% chained via `source_job_id`, ~2% failures, a few 50+-invocation chains.
- **Slow-prod simulation on a fast Mac**: data scale (above) is the honest simulator for DB-bound pain; for client-bound pain, Chrome CDP `Emulation.setCPUThrottlingRate(4–6×)` + `Network.emulateNetworkConditions` (Fast 3G / 40ms RTT also catches request waterfalls). Measured via Performance marks around: initial route render, search keystroke→results, facet change→table update, row→drawer open, chain page render. **Targets** (throttled, 200k-row DB): search < 400ms server round-trip, table page < 300ms, drawer < 300ms, chain render < 1.5s, Overview initial < 2s, zero queries fired while tab hidden.
- Measure → fix → re-measure loop, recorded in `console/PERF.md` (baseline vs after, per scenario).

## 9. Phased implementation

- **Phase C0 — this plan.** ✅
- **Phase C1 — lift & shift (works locally).** Port the app into `console/` unchanged-except: strip secrets (S2), fix B1 via Netlify-function proxy + vite proxy parity, rename branding, local wiring + seeder, codegen against local Hasura. *Done bar:* all five pages render seeded local data.
- **Phase C2 — deployable.** Netlify site + `console-ci.yml` + interim auth (proxy + site password) + `observability_viewer` role PR opened in hasura-migrations. *Done bar:* PR preview deploys green with no secret in the bundle.
- **Phase C3 — perf overhaul.** §4.3 server-side table, §4.1 search, §4.4 dashboard buckets + polling policy, P6/P7 render fixes, §6.2 indexes, bundle diet (drop antd, code-split reactflow/recharts, self-host fonts). *Done bar:* §8 targets met at 200k rows, before/after in `PERF.md`.
- **Phase C4 — UX upgrade.** Chain view, grouped search results page, deep links, detector-health panel, drawer upgrades, stale-running handling (B6), status vocabulary (U6). *Done bar:* an on-call engineer can go from "customer says move 41885 didn't text the driver" to the exact failed job in ≤3 interactions.
- **Phase C5 — eventkit-native (phased with D9).** Expected/Compare overlay on the chain canvas using committed flow YAML; `source_record_id` sink change + backfill; job checkpoints/progress UI. Sequenced behind the runtime migration per D9 — design here, build when Observed mode is proven.

## 10. Decisions to ratify

- **D-CON-1 (auth)**: Hasura JWT + `observability_viewer` role (recommended) vs long-term proxy. Interim = proxy + site password.
- **D-CON-2 (GraphQL path)**: client→Hasura direct with JWT (recommended once role lands) vs everything through a Netlify function.
- **D-CON-3 (retention)**: 90d detail / 13mo hourly rollups (recommended); who owns the purge job (a `cron-*` eventkit function is the natural home — dogfooding).
- **D-CON-4 (job logs)**: keep Loki as the log store, console reads via proxy (recommended — matches the Grafana investment) vs adding a `job_logs` writer to the sink. Revisit only if Loki retention/labels prove insufficient for per-job debugging.
- **D-CON-5 (repo placement)**: `console/` folder in this repo (recommended: it versions with the plugin/sink schema it renders) vs separate repo. This plan assumes in-repo.

## 11. Non-goals (now)
Console backend read-API service (§16/D9 — the SPA talks to Hasura directly), Compare-Mode matcher, Flow-Manifest authoring UI, multi-tenant/external access, mobile layouts.

---

## 12. Phase C5 progress — Expected + Compare shipped in the console (2026-07-02)

The three-mode canvas from `console-expected-flows.md` §2 is now implemented in the SPA:
**Observed** (unchanged), **Expected** (renders a committed `eventkit-flow` YAML doc — or a
`toFlowGraph` JSON — loaded from bundled samples or user upload, persisted in localStorage),
and **Compare** (the §3 matcher overlaying one run's correlation tree on the expected graph).
Node ids are the ADR-032 name-derived scheme, so no adapter layer was needed. The matcher
(`console/src/flowdoc/compare.ts`) is a pure, dependency-free function implementing the §3
vocabulary with confidence preserved and unmatched observed activity grafted as first-class
`unexpected_observed` nodes — written to be upstreamed verbatim into `@hopdrive/eventkit/flow`
(D-console-1) so CI and the console share one implementation.

Still open from the §5 plan: the backend read layer (docs are file-loaded client-side for
now), hand-authored manifest support (required/optional edges beyond `continueOnFailure`),
`condition_not_met` (needs the job no-op signal from the package review), and cross-kit
chain edges in the aggregated org view.

## 13. Post-C5 UX round (2026-07-02)

Shipped from live design feedback on the flow page:

- **Drawer navigation**: child-node rows in the drawers now pan/zoom the canvas to the
  clicked node (same drawer-aware centering as canvas clicks), and drawers carry a back
  button that walks the selection trail (`drawerHistory` in `FlowDiagram`).
- **Source-type awareness**: the observability plugin persists `source_type`
  (`ctx.sourceType` — eventkit `EventSourceType`) next to `source_system`; the sink upserts
  it; `invocations.source_type` added to the schema (⚠ prod Hasura needs the column via a
  hasura-migrations PR before the updated sink ships). The invocation node and drawer show
  a source chip (category icon + adapter name), and the drawer renders BY KIND: database
  sources keep record/operation facts + row-changes diff; webhook/cron/manual render their
  partner/caller payload inline as the primary content (no nonsensical row diff). Legacy
  rows with NULL source_type infer 'database' from the Hasura-shaped system/payload.
- **Breadcrumb trail** (`FlowBreadcrumb`): bottom-center bar showing origin → … → selected,
  recomputed from the edge graph on every selection change (canvas click, drawer jump,
  back); crumbs are kind-colored and clickable.
- **Layout rewrite** (`useFlowPositioning`): replaced the heuristic spacing (which let
  adjacent event groups' job fan-outs overlap — it reserved room for one group's jobs but
  not the next's) with a two-pass extent-based tidy tree: every node owns a band of
  max(node height + 48px gap, sum of child bands), nested through
  invocation → events → jobs → triggered invocations. Verified programmatically on a
  113-node / 17-invocation chain: 0 overlapping rects, min vertical gap exactly 48px.
