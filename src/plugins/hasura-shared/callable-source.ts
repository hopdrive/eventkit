// =============================================================================
// Callable-source assembly (ADR-039.2)
// =============================================================================
// Each Hasura-family adapter is exported as a value that is BOTH a ready-to-use
// plugin (`createEventKit(hasuraEvent)`) AND a factory (`createEventKit(hasuraEvent,
// config)`), with its authoring helpers (`.detector`, `.prepare`, …) attached.
// Assembling that shape takes care — `fn.name` is non-writable, so a plain
// `Object.assign` of `name` throws in strict mode — and was previously copy-pasted
// per source. This helper owns the assembly once; the sources own only `build()`.

import type { EventKitPlugin } from '../../core/index.js';

/**
 * Turn a `build(config)` plugin constructor into the callable source value: a
 * factory carrying every member of the default (`build({})`) plugin, so bare use,
 * configured use, and direct capability access (`hasuraEvent.normalize(...)`) all
 * work. The export site casts the result to the source's authored interface,
 * which is where the typed `.detector`/`.prepare`/`.resolve` signatures live.
 */
export function callableSource<TConfig extends object, TSource>(
  build: (config: TConfig) => EventKitPlugin,
): TSource {
  const factory = (config: TConfig = {} as TConfig): EventKitPlugin => build(config);
  const { name, ...members } = build({} as TConfig);
  Object.assign(factory, members);
  // `fn.name` is non-writable; set the plugin name via defineProperty.
  Object.defineProperty(factory, 'name', { value: name, configurable: true });
  return factory as TSource;
}

/**
 * The runtime value behind every typed authoring helper (`.detector`, `.prepare`,
 * `.resolve`): an identity function. The runtime supplies the enriched context at
 * execution time; the source's authored interface supplies the types (including
 * the D32 `TPrepared` inference), so no per-source wrapper body is needed.
 */
export const authoringHelper = (fn: unknown): unknown => fn;
