// =============================================================================
// callableSource — the shared assembly behind the Hasura source family
// =============================================================================
// The three Hasura adapters previously copy-pasted this factory dance; these
// tests pin the contract the extraction must preserve for ALL of them:
//   • the export is callable (bare AND configured use both build a plugin);
//   • every member of the default plugin is attached to the factory value;
//   • `name` is the PLUGIN name (set via defineProperty — fn.name is non-writable);
//   • the config actually reaches build() (a configured instance differs).
import { describe, it, expect } from 'vitest';
import { callableSource, authoringHelper } from '../hasura-shared/callable-source.js';
import { hasuraEvent, hasuraCron, hasuraAction } from '../source-hasura.js';
import type { EventKitPlugin } from '../../core/index.js';

interface FixtureConfig {
  flavor?: string;
}
interface FixtureSource extends EventKitPlugin {
  (config?: FixtureConfig): EventKitPlugin;
  flavorOf(): string;
}

const buildFixture = (config: FixtureConfig): EventKitPlugin =>
  ({
    name: 'source-fixture',
    provides: ['source', 'source:fixture'],
    sourceType: 'application',
    flavorOf: () => config.flavor ?? 'default',
  }) as EventKitPlugin;

describe('callableSource', () => {
  const fixture = callableSource<FixtureConfig, FixtureSource>(buildFixture);

  it('is callable: bare use and configured use both yield a plugin', () => {
    expect(typeof fixture).toBe('function');
    expect(fixture().name).toBe('source-fixture');
    expect(fixture({ flavor: 'vanilla' }).name).toBe('source-fixture');
  });

  it('threads the config into build()', () => {
    const configured = fixture({ flavor: 'mint' }) as EventKitPlugin & { flavorOf(): string };
    expect(configured.flavorOf()).toBe('mint');
    // The bare factory value carries the DEFAULT (build({})) members.
    expect(fixture.flavorOf()).toBe('default');
  });

  it('carries the plugin name on the factory value (fn.name is non-writable)', () => {
    expect(fixture.name).toBe('source-fixture');
  });

  it('attaches every default-plugin member to the factory value', () => {
    expect(fixture.provides).toEqual(['source', 'source:fixture']);
    expect(fixture.sourceType).toBe('application');
  });

  it('authoringHelper is an identity passthrough', () => {
    const fn = () => true;
    expect(authoringHelper(fn)).toBe(fn);
  });
});

describe('the Hasura family keeps the callable-source contract', () => {
  const cases = [
    { source: hasuraEvent, name: 'source-hasura-event', sourceType: 'database' },
    { source: hasuraCron, name: 'source-hasura-cron', sourceType: 'cron' },
    { source: hasuraAction, name: 'source-hasura-action', sourceType: 'action' },
  ] as const;

  it.each(cases)('$name: callable, named, capability-complete', ({ source, name, sourceType }) => {
    // Bare value IS the default plugin…
    expect(source.name).toBe(name);
    expect(source.sourceType).toBe(sourceType);
    expect(typeof source.normalize).toBe('function');
    expect(typeof source.buildDetectorContext).toBe('function');
    expect(typeof source.buildHandlerContext).toBe('function');
    expect(typeof source.detector).toBe('function');
    expect(typeof source.prepare).toBe('function');
    // …and calling it as a factory yields a configured plugin with the same identity.
    const configured = (source as unknown as (c?: object) => EventKitPlugin)({});
    expect(configured.name).toBe(name);
    expect(typeof configured.normalize).toBe('function');
  });

  it('authoring helpers return the authored function unchanged', () => {
    const detect = () => true;
    expect(hasuraEvent.detector(detect as never)).toBe(detect);
    expect(hasuraAction.resolve(detect as never)).toBe(detect);
  });
});
