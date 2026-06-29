# @hopdrive/eventkit

Source-agnostic business-event execution framework. The successor to
`@hopdrive/hasura-event-detector` — Hasura becomes one *source adapter* rather than
the center of the architecture.

> **Status: Phase 4 (platform adapters).** The kit detects + runs jobs end to end with
> the real `hasuraEvent` source, the built-in plugins, and platform adapters — a `db-*`
> function runs via `kit.handler()` with no hand-written `getRemainingTimeInMillis`.
> Design source of truth: `hasura-event-detector/docs/eventkit-rewrite/` (RFC v0.3.8 +
> kickoff).

## What works now (Phases 0–4)

- **Package skeleton** — dual ESM/CJS build, subpath `exports` map, three-tsconfig
  setup, marker `package.json` files, Changesets, and a CI **Netlify-bundle smoke
  test** (the D8 release gate).
- **Frozen public types** (`src/core`) — every §9/§11 RFC interface plus the helper
  types the RFC left loose (`Capability`, `JobDefinition`, `PluginFactory`,
  `NormalizeFn`/`FormatFn`, `KitContext`, `DetectionResult`/`HandlerResult`, the
  logger tiers, `EventModuleMetadata`, `SerializedError`).
- **Core runtime** (`src/runtime`) — `createEventKit` / `use` / `registerEvents` /
  `validate` / `handle`, and `run()` (parallel + continue-on-failure defaults, strict
  `JobDefinition[]`, `augmentJobContext` merge + ambient tracking token, per-job
  timeout, AbortSignal cancellation, retries). Plugin manager with lazy instantiation,
  registration-order notifications, delta transforms, and capability validation.
- **`hasuraEvent` source** (`@hopdrive/eventkit/sources/hasura`) — `normalize` +
  `buildDetectorContext` (operation/rows/`columnChanged()`/`manuallyInvoked()`/…) +
  `buildHandlerContext` (`HasuraHandlerContext`). The `switch (ctx.operation)` detector
  house style; `appointment.ready` example + tests.
- **Built-in plugins** (config-driven, subpath exports — ADR-024):
  `./plugins/loop-prevention` (`loopPrevention` + a generic tracking-token codec),
  `./plugins/observability` (buffered, sink-based, full canonical record set) +
  `./plugins/observability/graphql-sink` (built-in Hasura bulk-upsert sink),
  `./plugins/batchjobs`
  (registration-emergent durability, `requires: ['source:hasura']`),
  `./plugins/transports/grafana` and `./plugins/transports/sentry`.
- **Testing** (`@hopdrive/eventkit/testing`) — `fakeSource`, `defineFakeEvent`,
  `buildDetectorContextFor`, `buildHandlerContextFor`; 42 unit tests.
- **Platform adapters** (`@hopdrive/eventkit/platforms`) — `lambdaPlatform`,
  `netlifyPlatform` (classic), `netlifyBackgroundPlatform`, `netlifyV2Platform`; three
  time-budget strategies via `RequestContext.getRemainingTimeMs`; `kit.handler()`;
  detect-and-warn.
- **Pure utilities**: `serializeError`, `serializeOutput`, `replaceCircularReferences`,
  `job()`, branded-id helpers.
- **Stubbed until later phases** (throw `NotImplementedError`): `hasuraCron` (Phase 5).

## Public surface

```ts
import { createEventKit, job, run } from '@hopdrive/eventkit';
import { hasuraEvent } from '@hopdrive/eventkit/sources/hasura';
import { batchJobs } from '@hopdrive/eventkit/plugins/batchjobs';
import { observability } from '@hopdrive/eventkit/plugins/observability';
import { loopPrevention } from '@hopdrive/eventkit/plugins/loop-prevention';
import { grafanaTransport } from '@hopdrive/eventkit/plugins/transports/grafana';
import { netlifyPlatform } from '@hopdrive/eventkit/platforms';
```

Loop-prevention (tracking token), grafana, and sentry are **generic mechanisms
parameterized by injected config**, so they ship built-in (ADR-024) — there is no
separate `@hopdrive/app-eventkit` package. The HopDrive layer is just config presets
(the `updated_by` field, token format `{ separator: '|' }`, service id), any future
SDK-coupled enrichment plugin, and the event modules (which live in the consumer
repos). Whether those presets warrant a package is deferred (D23 — likely not).

## Open decisions — proceeding on recommended defaults

D19 → positional `createEventKit(source)`; D20 → qualified capability tokens
(`'source:hasura'`); D22 → lazy plugin instantiation; D6 → shadow-mode parity before
cutover; D7 → no compat facade; D8 → single package + subpath exports gated on the
bundle smoke test. (Flagged for ratification.)

## Develop

```bash
npm install
npm run build                # dual ESM/CJS + .d.ts
npm run typecheck            # strict, no emit
npm run typecheck:contracts  # negative-type fixtures (brand/contribution guards)
npm test                     # vitest
npm run smoke:bundle         # D8 gate: every subpath resolves under esbuild
```
