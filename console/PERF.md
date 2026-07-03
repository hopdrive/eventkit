# EventKit Console — Perf Log

Baseline and before/after measurements from `perf/measure.mjs`, per docs/planning/console-migration-plan.md §8.

## 2026-07-02T05:07:32.577Z

- git sha: `55bcdc9`
- seed: 200,000 invocations / 2,799,564 event_executions / 798,904 job_executions
- throttle: CPU 4x slowdown; network latency=40ms, download=1.6Mbps, upload=0.75Mbps (Fast-3G-ish)

| Scenario | Median | GraphQL requests | Bytes | Notes |
|---|---|---|---|---|
| cold-load-overview | n/a | n/a | n/a | errors: Navigation timeout of 60000 ms exceeded; Navigation timeout of 60000 ms exceeded; Navigation timeout of 60000 ms exceeded |
| cold-load-invocations | 68.88s | 4 | 936.7KB |  |
| search-keystrokes | n/a | n/a | n/a | errors: Navigation timeout of 60000 ms exceeded; Navigation timeout of 60000 ms exceeded; Navigation timeout of 60000 ms exceeded |
| search-correlation | n/a | n/a | n/a | errors: Navigation timeout of 60000 ms exceeded; Navigation timeout of 60000 ms exceeded; Protocol error (Target.closeTarget): No target with given id found |
| facet-status-failed | n/a | n/a | n/a | errors: Protocol error (Target.createTarget): Failed to open a new tab; Protocol error (Target.createTarget): Target closed; Connection closed. |
| paginate | n/a | n/a | n/a | errors: Connection closed.; Connection closed.; Connection closed. |
| drawer-open | n/a | n/a | n/a | errors: Connection closed.; Connection closed.; Connection closed. |
| flow-render | n/a | n/a | n/a | errors: Connection closed.; Connection closed.; Connection closed. |
| hidden-tab-poll | n/a | n/a | n/a | errors: Connection closed.; Connection closed.; Connection closed. |

## 2026-07-02T05:42:58.220Z

- git sha: `55bcdc9`
- seed: 200,000 invocations / 2,799,564 event_executions / 798,904 job_executions
- throttle: CPU 4x slowdown; network latency=40ms, download=1.6Mbps, upload=0.75Mbps (Fast-3G-ish)

| Scenario | Median | GraphQL requests | Bytes | Notes |
|---|---|---|---|---|
| cold-load-overview | 67.68s | 4 | 284.8KB |  |
| cold-load-invocations | 68.47s | 4 | 936.7KB |  |
| search-keystrokes | 15.02s | 20 | 49.8KB | gqlCount = requests fired during typing (debounce metric) |
| search-correlation | 15.04s | 2 | 0B |  |
| facet-status-failed | 276ms | 0 | 0B | client-side filter over the already-fetched page (P1/U3 — no server round trip today) |
| paginate | 198ms | 0 | 0B | client-side pagination over the already-fetched page |
| drawer-open | 382ms | 0 | 0B |  |
| flow-render | 62.36s | 4 | 6.7KB |  |
| hidden-tab-poll | 30.00s | 8 | 838.3KB | gqlCount = GraphQL requests fired during a 30s emulated-hidden window (target: 0) |

## 2026-07-02T11:35:23.708Z

- git sha: `55bcdc9`
- seed: 200,000 invocations / 2,799,564 event_executions / 798,904 job_executions
- throttle: CPU 4x slowdown; network latency=40ms, download=1.6Mbps, upload=0.75Mbps (Fast-3G-ish)

| Scenario | Median | GraphQL requests | Bytes | Notes |
|---|---|---|---|---|
| cold-load-overview | 7.17s | 4 | 215.7KB | errors: Waiting failed: 150000ms exceeded; Waiting failed: 150000ms exceeded |
| cold-load-invocations | n/a | n/a | n/a | errors: Waiting failed: 150000ms exceeded; Waiting failed: 150000ms exceeded; Waiting failed: 150000ms exceeded |
| search-keystrokes | 513ms | 20 | 1.8KB | gqlCount = requests fired during typing (debounce metric) |
| search-correlation | 482ms | 2 | 185B |  |
| facet-status-failed | n/a | n/a | n/a | errors: Waiting failed: 60000ms exceeded; Waiting failed: 60000ms exceeded; Waiting failed: 60000ms exceeded |
| paginate | n/a | n/a | n/a | errors: Waiting failed: 60000ms exceeded; Waiting failed: 60000ms exceeded; Waiting failed: 60000ms exceeded |
| drawer-open | n/a | n/a | n/a | errors: Waiting failed: 60000ms exceeded; Waiting failed: 60000ms exceeded; Waiting failed: 60000ms exceeded |
| flow-render | n/a | n/a | n/a | errors: Waiting failed: 150000ms exceeded; Waiting failed: 150000ms exceeded; Waiting failed: 150000ms exceeded |
| hidden-tab-poll | n/a | n/a | n/a | errors: Waiting failed: 30000ms exceeded; Waiting failed: 30000ms exceeded; Waiting failed: 30000ms exceeded |

## 2026-07-02T11:45:28.315Z

- git sha: `55bcdc9`
- seed: 200,000 invocations / 2,799,564 event_executions / 798,904 job_executions
- throttle: CPU 4x slowdown; network latency=40ms, download=1.6Mbps, upload=0.75Mbps (Fast-3G-ish)

| Scenario | Median | GraphQL requests | Bytes | Notes |
|---|---|---|---|---|
| cold-load-overview | 6.45s | 4 | 208.6KB |  |
| cold-load-invocations | 8.86s | 4 | 936.7KB |  |
| search-keystrokes | 15.02s | 20 | 49.8KB | gqlCount = requests fired during typing (debounce metric) |
| search-correlation | 15.05s | 2 | 0B |  |
| facet-status-failed | 217ms | 0 | 0B | client-side filter over the already-fetched page (P1/U3 — no server round trip today) |
| paginate | 189ms | 0 | 0B | client-side pagination over the already-fetched page |
| drawer-open | 337ms | 0 | 0B |  |
| flow-render | 2.78s | 4 | 6.7KB |  |
| hidden-tab-poll | 30.00s | 8 | 414.9KB | gqlCount = GraphQL requests fired during a 30s emulated-hidden window (target: 0) |

## 2026-07-02T11:52:36.213Z

- git sha: `6e3c629`
- seed: 200,000 invocations / 2,799,564 event_executions / 798,904 job_executions
- throttle: CPU 4x slowdown; network latency=40ms, download=1.6Mbps, upload=0.75Mbps (Fast-3G-ish)

| Scenario | Median | GraphQL requests | Bytes | Notes |
|---|---|---|---|---|
| cold-load-overview | 6.52s | 4 | 206.7KB |  |
| cold-load-invocations | 2.86s | 4 | 8.5KB |  |
| search-keystrokes | n/a | n/a | n/a | errors: Waiting for selector `input[placeholder^="Search by correlation ID"]` failed; Waiting for selector `input[placeholder^="Search by correlation ID"]` failed; Waiting for selector `input[placeholder^="Search by correlation ID"]` failed |
| search-correlation | n/a | n/a | n/a | errors: Waiting for selector `input[placeholder^="Search by correlation ID"]` failed; Waiting for selector `input[placeholder^="Search by correlation ID"]` failed; Waiting for selector `input[placeholder^="Search by correlation ID"]` failed |
| facet-status-failed | 26ms | 0 | 0B | client-side filter over the already-fetched page (P1/U3 — no server round trip today) |
| paginate | 295ms | 0 | 0B | client-side pagination over the already-fetched page |
| drawer-open | 60ms | 0 | 0B |  |
| flow-render | 2.70s | 4 | 6.7KB |  |
| hidden-tab-poll | 30.00s | 2 | 157B | gqlCount = GraphQL requests fired during a 30s emulated-hidden window (target: 0) |

## 2026-07-02T11:59:46.789Z

- git sha: `6e3c629`
- seed: 200,000 invocations / 2,799,564 event_executions / 798,904 job_executions
- throttle: CPU 4x slowdown; network latency=40ms, download=1.6Mbps, upload=0.75Mbps (Fast-3G-ish)

| Scenario | Median | GraphQL requests | Bytes | Notes |
|---|---|---|---|---|
| cold-load-overview | 4.96s | 8 | 97.6KB |  |
| cold-load-invocations | 2.79s | 4 | 8.5KB |  |
| search-keystrokes | 0ms | 0 | 0B | gqlCount = requests fired during typing (debounce metric) |
| search-correlation | 12ms | 0 | 0B |  |
| facet-status-failed | 25ms | 0 | 0B | client-side filter over the already-fetched page (P1/U3 — no server round trip today) |
| paginate | 293ms | 0 | 0B | client-side pagination over the already-fetched page |
| drawer-open | 61ms | 0 | 0B |  |
| flow-render | 2.71s | 4 | 6.7KB |  |
| hidden-tab-poll | 30.00s | 2 | 157B | gqlCount = GraphQL requests fired during a 30s emulated-hidden window (target: 0) |

## 2026-07-02T12:10:04.653Z

- git sha: `6e3c629`
- seed: 200,000 invocations / 2,799,564 event_executions / 798,904 job_executions
- throttle: CPU 4x slowdown; network latency=40ms, download=1.6Mbps, upload=0.75Mbps (Fast-3G-ish)

| Scenario | Median | GraphQL requests | Bytes | Notes |
|---|---|---|---|---|
| cold-load-overview | 4.70s | 8 | 96.5KB |  |
| cold-load-invocations | 2.42s | 6 | 8.4KB |  |
| search-keystrokes | 0ms | 0 | 0B | gqlCount = requests fired during typing (debounce metric) |
| search-correlation | 13ms | 0 | 0B |  |
| facet-status-failed | 119ms | 0 | 0B | client-side filter over the already-fetched page (P1/U3 — no server round trip today) |
| paginate | 157ms | 0 | 0B | client-side pagination over the already-fetched page |
| drawer-open | 153ms | 0 | 0B |  |
| flow-render | 2.52s | 4 | 6.7KB |  |
| hidden-tab-poll | 30.00s | 2 | 157B | gqlCount = GraphQL requests fired during a 30s emulated-hidden window (target: 0) |

## 2026-07-02T12:14:44.742Z

- git sha: `6e3c629`
- seed: 200,000 invocations / 2,799,564 event_executions / 798,904 job_executions
- throttle: CPU 4x slowdown; network latency=40ms, download=1.6Mbps, upload=0.75Mbps (Fast-3G-ish)

| Scenario | Median | GraphQL requests | Bytes | Notes |
|---|---|---|---|---|
| cold-load-overview | 4.70s | 8 | 95.8KB |  |
| cold-load-invocations | 2.44s | 6 | 8.4KB |  |
| search-keystrokes | 3.90s | 6 | 9.5KB | gqlCount = requests fired during typing (debounce metric) |
| search-correlation | 3.91s | 6 | 1.2KB |  |
| facet-status-failed | 109ms | 0 | 0B | client-side filter over the already-fetched page (P1/U3 — no server round trip today) |
| paginate | 206ms | 0 | 0B | client-side pagination over the already-fetched page |
| drawer-open | 152ms | 0 | 0B |  |
| flow-render | 2.52s | 4 | 6.7KB |  |
| hidden-tab-poll | 30.00s | 2 | 157B | gqlCount = GraphQL requests fired during a 30s emulated-hidden window (target: 0) |

---

## Final summary — Phase C3 (2026-07-02, 200k invocations / 2.8M events / 800k jobs, 4x CPU + Fast-3G throttle)

| scenario | baseline | after C3 | requests | bytes |
|---|---:|---:|---|---|
| cold-load-overview | 6,451ms | 4,696ms | 4→8 | 214KB→98KB |
| cold-load-invocations | 8,865ms | **2,444ms** | 4→6 | **959KB→8.6KB** |
| search-keystrokes | 15,021ms | **3,901ms** | **20→6** | 51KB→9.7KB |
| search-correlation | 15,048ms | **3,907ms** | 2→6 | — |
| facet-status-failed | 217ms | 109ms | server-side now | |
| paginate | 189ms | 206ms | server-side now | |
| drawer-open | 337ms | 152ms | | |
| flow-render | 2,777ms | 2,519ms | | |
| hidden-tab-poll (30s) | 8 req / 425KB | **2 req / 157B** | | |

Semantics changed alongside speed: search/facets/pagination now cover the ENTIRE
dataset server-side (the baseline's "fast" facet/paginate numbers were client-side
over a stale 1,000-row window that silently missed data). Throttled numbers ≈ 3-4x
real-world unthrottled latency.

What did it: payload/aggregate removal from the list query; server-side
where/order/limit/offset; 250ms debounce; GroupedSearch on indexed columns
(pg_trgm GIN on event_name/job_name/source_function/correlation_id); count split
from rows; bucketed chart aggregates instead of fetch-all; poll 5s→30s + full stop
when hidden; ReactFlow remount/animation fixes; route + vendor code-splitting.

Known follow-ups: common-term suggestion queries still bitmap-scan ~57k rows
(~0.7-1.2s server-side; consider bounding suggestions to a recent window or a name
dimension table); recharts still loads with the default route (lazy-split Overview
chart next); flow-render dominated by the InvocationTreeFlow query depth.
