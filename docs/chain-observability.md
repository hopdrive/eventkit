# Chains in the console: roots, rollup, and permalinks

The unit of debugging is the chain: all the invocations that share one correlation id.
A user action or a database write kicks off a first invocation, that invocation's jobs
write more rows, those writes trigger more invocations, and so on. They all carry the same
correlation id. The console treats that whole chain as one thing without needing a separate
chains table: the rollup lives on the chain's root row.

This sits next to [chained-events.md](chained-events.md) (how one correlation id is kept
across a chain) and [origin-trace-decoding.md](origin-trace-decoding.md) (the optional
frontend-action label). Read those first if the terms are new.

## What a chain root is

A chain root is the invocation that MINTED the chain's correlation id. Every other
invocation in the chain INHERITED that id from an upstream invocation (through the tracking
token that loop-guard lifts), so exactly one invocation per chain is the root.

Root is decided by that fact alone. It is never inferred from timestamps, and it does not
depend on whether the chain has a decoded origin. A chain that starts at a bare database
insert with no frontend header gets a root, a rollup, and full chain health exactly like a
chain that started at a decoded button click. Origin is optional decoration on top; the
chain machinery does not need it.

How the writer knows: a source sets `meta.correlationMinted` when it generates a fresh
correlation id (nothing was inherited). If loop-guard then adopts an inbound token's
correlation id, it clears the flag, because that invocation inherited its id. The
observability writer reads the settled flag and stores it as `is_chain_root`.

## The rollup columns

Four columns on `invocations` carry the chain summary. Three are meaningful only on the
root row:

- `is_chain_root` (boolean) — true on the minting invocation.
- `chain_status` (root only) — `ok` or `errored`. Room is left for a future `incomplete`
  that a sweeper will stamp; this repo does not build the sweeper.
- `chain_last_activity_at` (root only) — the start time of the most recent member
  invocation in the chain.
- `origin_action` — the decoded origin action slug (e.g. `dealer.move.create`), promoted
  out of `context_data.origin.action` so it can be indexed, filtered, and sorted. Null when
  there is no decoded origin.

### The writer invariant

On every member invocation write (root or not), the observability writer rolls two facts
up onto the chain's root row, each a single indexed UPDATE keyed by
`(correlation_id, is_chain_root = true)`:

- Bump `chain_last_activity_at` to this member's start, greatest-wins (the UPDATE only
  touches the root when the new time is later, so no read-before-write is needed).
- If this member errored, flip `chain_status` to `errored`. It never flips back to `ok`,
  so a chain that errored anywhere stays errored even if later members succeed.

Both rollup writes are best-effort. They swallow every failure (a transport error, or an
older schema that does not have the chain columns yet) so telemetry never blocks or fails
business execution. This means a chain's root can read `errored` even though the root
invocation itself completed cleanly, because a downstream member failed. That is the point:
the row you scan is the chain's health, not just the root's.

Schema: the columns and their indexes are in `console/db/schema.sql`. For an existing
observability database, apply `console/db/schema-delta-chain-rollup.sql`, and apply it
BEFORE deploying the writer that sets these columns (the writer lists them in its
invocation upsert). HopDrive's production obs schema is managed in the separate
hasura-migrations repo.

## The permalink contract

The flow page is addressable by a whole chain, not just one invocation:

```
/flow?correlationId=<correlation-id>
```

This is the stable deep link that external tools (Sentry, Grafana) point at. It resolves
the correlation id to the chain root (or the earliest member if no root row was recorded)
and renders the same flow diagram as `?invocationId=`. Because it keys on the correlation
id, it survives even as individual invocation rows come and go.

## The chains index

The console's Invocations screen defaults to a "Chains" view: one row per chain, queried as
plain root rows (`is_chain_root = true`) with no group-by, sorted by
`chain_last_activity_at` descending. Each row shows the origin action chip when present (or
the root's event/function otherwise), the user, the chain status (the row's status color
follows `chain_status`), last activity, and a per-chain invocation count and span computed
for the visible page only.

- Errors-only toggle: `?errors=1` filters to `chain_status = 'errored'`.
- Per-action index: `?action=<slug>` filters to one `origin_action`.
- A view toggle switches to the flat all-invocations table for raw invocation rows.

The dashboard leads with the same chain health: an errored-chain count with its trend
against the previous window, a feed of the most recent errored chains, and the top origin
actions by chain volume with their errored rate.
