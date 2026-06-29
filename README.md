# @hopdrive/eventkit

Source-agnostic business-event execution framework. The successor to
`@hopdrive/hasura-event-detector` — Hasura becomes one *source adapter* rather than
the center of the architecture.

> **Status: Phase 0 (skeleton + type freeze).** The public contracts are frozen and
> importable; the runtime is stubbed (calling `createEventKit`/`run`/a source/plugin
> throws `NotImplementedError`). Design source of truth:
> `hasura-event-detector/docs/eventkit-rewrite/` (RFC v0.3.7 + kickoff).

## What's here in Phase 0

- **Package skeleton** — dual ESM/CJS build, subpath `exports` map, three-tsconfig
  setup, marker `package.json` files, Changesets, and a CI **Netlify-bundle smoke
  test** (the D8 release gate).
- **Frozen public types** (`src/core`) — every §9/§11 RFC interface plus the helper
  types the RFC left loose (`Capability`, `JobDefinition`, `PluginFactory`,
  `NormalizeFn`/`FormatFn`, `KitContext`, `DetectionResult`/`HandlerResult`, the
  logger tiers, `EventModuleMetadata`, `SerializedError`).
- **Implemented now** (pure leaf utilities): `serializeError`, `serializeOutput`,
  `replaceCircularReferences`, `job()` (the definition builder), and the branded-id
  helpers.
- **Stubbed until later phases**: `run()` + `createEventKit()` (Phase 1), the Hasura
  source runtime (Phase 2), `batchJobs`/`observability` (Phase 3), platform adapters
  (Phase 4).

## Public surface

```ts
import { createEventKit, job, run } from '@hopdrive/eventkit';
import { hasuraEvent } from '@hopdrive/eventkit/sources/hasura';
import { batchJobs } from '@hopdrive/eventkit/plugins/batchjobs';
import { observability } from '@hopdrive/eventkit/plugins/observability';
import { netlifyPlatform } from '@hopdrive/eventkit/platforms';
```

HopDrive-specific plugins (`trackingToken`, `grafanaLogger`, `sentry`) deliberately do
**not** live here — they belong in a separate `@hopdrive/app-eventkit` package so core
stays domain-agnostic (§3.3). Core only exposes the seams they hang on
(`ctx.trackingToken`, `envelope.meta.sourceTrackingToken`, `augmentJobContext`).

## Open decisions — proceeding on recommended defaults

D19 → positional `createEventKit(source)`; D20 → qualified capability tokens
(`'source:hasura'`); D22 → lazy plugin instantiation; D6 → shadow-mode parity before
cutover; D7 → no compat facade; D8 → single package + subpath exports gated on the
bundle smoke test. (Flagged for ratification.)

## Develop

```bash
npm install
npm run build          # dual ESM/CJS + .d.ts
npm run typecheck      # strict, no emit
npm run smoke:bundle   # D8 gate: every subpath resolves under esbuild
```
