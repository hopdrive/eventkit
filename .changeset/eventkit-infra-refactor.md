---
'hopdrive-eventkit': minor
---

Internal simplification pass — behavior and the public API are unchanged, with one deliberate removal.

- **Removed dead export `NotImplementedError`** (root and `/core`). It was a Phase-0 scaffolding relic: no runtime code path ever threw it, so nothing could ever catch it. Migration: delete any import of it — there is no replacement because there was no behavior.
- The three Hasura sources (`hasuraEvent`, `hasuraCron`, `hasuraAction`) now share one `callableSource` assembly helper instead of three copy-pasted factory blocks; their runtime shape (callable + attached authoring helpers + plugin `name`) is pinned by new tests.
- `handle()` and `dryRun()` share one intake pipeline (extract → normalize → augment), and the `resolve`/`respond` seams share one error-mapping path — the invocation lifecycle now reads in one place.
- Consolidated six copies of the `crypto.randomUUID` fallback and two copies of `isJobDefinition` into single internal helpers; the two Netlify v2 platforms share the Web-`Response` rejection formatter.
- `docs/guide.html`: documented `kit.dryRun()` and the Hasura sources' factory/config form (inbound token discovery) in the API reference.
