-- ---------------------------------------------------------------------------
-- Delta: chain rollup columns on invocations
-- ---------------------------------------------------------------------------
-- Apply this to an EXISTING observability database that was created from an
-- older schema.sql (before the chain columns). A fresh schema.sql already
-- includes everything here, so you only need this when upgrading in place.
--
-- These columns make a chain (all invocations sharing a correlation_id)
-- first-class without a new table: the root row carries the rollup, and the
-- console's default "Chains" view queries root rows directly.
--
-- Deploy ordering: apply this BEFORE deploying the eventkit version whose
-- observability writer sets these columns. The writer lists them in its
-- invocation upsert, so an older schema without them would reject every
-- invocation insert. (The chain rollup UPDATEs are best-effort and degrade
-- silently, but the insert is not.)
--
-- HopDrive's production obs schema is managed in the separate hasura-migrations
-- repo; this file is the canonical delta for anyone running their own obs DB.
-- Idempotent — safe to re-run.
-- ---------------------------------------------------------------------------

ALTER TABLE invocations ADD COLUMN IF NOT EXISTS origin_action TEXT;
ALTER TABLE invocations ADD COLUMN IF NOT EXISTS is_chain_root BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE invocations ADD COLUMN IF NOT EXISTS chain_status TEXT;
ALTER TABLE invocations ADD COLUMN IF NOT EXISTS chain_last_activity_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_invocations_chain_roots
  ON invocations(chain_last_activity_at DESC) WHERE is_chain_root;
CREATE INDEX IF NOT EXISTS idx_invocations_errored_chain_roots
  ON invocations(chain_last_activity_at DESC) WHERE is_chain_root AND chain_status = 'errored';
CREATE INDEX IF NOT EXISTS idx_invocations_origin_action
  ON invocations(origin_action);
