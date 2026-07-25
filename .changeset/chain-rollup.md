---
'hopdrive-eventkit': minor
---

Make the chain (all invocations sharing a correlation id) first-class in observability.

Sources now expose `meta.correlationMinted` so the observability writer can flag the chain root truthfully (the invocation that minted the correlation id, never inferred from timestamps, independent of any decoded origin). The writer stamps `is_chain_root`, promotes `context_data.origin.action` to an indexed `origin_action`, and on every member write rolls a summary up onto the chain's root row: `chain_last_activity_at` (greatest-wins) and `chain_status` (flips to `errored` when any member errored, never back). The rollup is best-effort and never blocks event handling.

New `invocations` columns (`origin_action`, `is_chain_root`, `chain_status`, `chain_last_activity_at`) with indexes are in `console/db/schema.sql`; existing databases apply `console/db/schema-delta-chain-rollup.sql` before deploying the writer.

The console gains a chain-first Invocations index, a `flow?correlationId=` permalink, origin-action search and filtering, and a health-led dashboard. See `docs/chain-observability.md`.
