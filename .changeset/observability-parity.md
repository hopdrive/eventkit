---
'@hopdrive/eventkit': minor
---

Observability feature parity + built-in GraphQL sink.

- **Source-meta convention** (`core` `SourceMeta`): a source surfaces its
  attributes into `envelope.meta` under well-known keys so source-agnostic plugins
  read them without parsing a source payload. `hasuraEvent.normalize` populates
  `source_table`/`source_operation`/`source_event_id`/`source_user_email`/
  `source_user_role`; `loopPrevention` surfaces `sourceJobId` (the prior-job link)
  from the inbound token.
- **Observability rewrite to parity** with the legacy plugin's captured field set:
  the canonical `invocations`/`event_executions`/`job_executions` columns
  (source_* attributes, `source_event_payload`, `context_data`, aggregate counts;
  per-event job counts + module path; job `function_name`/`options`/`result`).
  Jobs are recorded at `onJobStart` (status `running`) and finalized at `onJobEnd`;
  `onError` marks the invocation failed and captures framework/detector/handler
  crashes outside the *End hooks; optional periodic mid-invocation flush
  (`flushIntervalMs`, upsert) feeds the live Console view of long-running
  invocations; `safeSerialize` (SDK/Apollo/GraphQL-client duck-typing + depth/size
  limits) guards persisted payloads. Still a pure, best-effort observer.
- **Built-in `graphqlSink`** at `./plugins/observability/graphql-sink` —
  `graphqlSink({ endpoint, headers, … })` bulk-upserts the batch to the canonical
  Hasura tables in FK order via `fetch` (no `graphql-request` dependency) with
  retry/backoff. The transport stays the consumer's `sink`; this ships the
  battle-tested HopDrive one in the box.

New subpath in exports/smoke (11 subpaths now)/CI. 4 new tests (46 total).
