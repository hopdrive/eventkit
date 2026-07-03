// =============================================================================
// API surface freeze (testing-strategy.md §20, P2 surface-freeze)
// =============================================================================
// Enumerate the RUNTIME (value) exports of every published subpath and snapshot
// the sorted name list. An accidental export removal or rename — the classic
// silent breaking change across ~245 consumer modules — then fails CI with a
// readable diff. Type-only exports are erased at runtime and don't appear here;
// they're frozen instead by tsc + the compile-checked type contracts
// (tsconfig.typetest.json). `./testing` is included: it is now a versioned
// public surface (ADR-036), held to the same discipline as the runtime.
import { describe, it, expect } from 'vitest';

// Subpath → source entry module (mirrors package.json "exports"; dist/esm/X.js ↔ ../X.ts).
const SUBPATHS: Record<string, string> = {
  '.': '../index.js',
  './core': '../core/index.js',
  './sources': '../plugins/sources.js',
  './plugins': '../plugins/index.js',
  './sources/hasura': '../plugins/source-hasura.js',
  './sources/webhook': '../plugins/source-webhook/index.js',
  './plugins/batch': '../plugins/batch/index.js',
  './plugins/observability': '../plugins/observability/index.js',
  './plugins/observability/graphql-sink': '../plugins/observability/graphql-sink.js',
  './plugins/loop-guard': '../plugins/loop-guard/index.js',
  './plugins/correlation-resolver': '../plugins/correlation-resolver/index.js',
  './plugins/transports/grafana': '../plugins/grafana/index.js',
  './plugins/transports/sentry': '../plugins/sentry/index.js',
  './platforms': '../plugins/platforms.js',
  './testing': '../testing/index.js',
  './flow': '../flow/index.js',
};

describe('published API surface (value exports per subpath)', () => {
  it('matches the frozen snapshot — an added/removed/renamed export must be intentional', async () => {
    const surface: Record<string, string[]> = {};
    for (const [subpath, module] of Object.entries(SUBPATHS)) {
      const mod = (await import(module)) as Record<string, unknown>;
      surface[subpath] = Object.keys(mod)
        .filter(k => k !== 'default')
        .sort();
    }
    expect(surface).toMatchSnapshot();
  });
});
