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
import { createEventKit } from '../../index.js';
import { hasuraUpdate } from '../../testing/index.js';
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
    expect(hasuraAction.prepare(detect as never)).toBe(detect);
  });
});

describe('source-scoped defineEvent', () => {
  it('is attached to the bare source AND to a configured instance', () => {
    expect(typeof hasuraEvent.defineEvent).toBe('function');
    expect(typeof (hasuraEvent({}) as unknown as { defineEvent: unknown }).defineEvent).toBe('function');
    expect(typeof hasuraCron.defineEvent).toBe('function');
    expect(typeof hasuraAction.defineEvent).toBe('function');
  });

  it('is core defineEvent at runtime: brands the name, passes the module through', () => {
    const detector = () => true;
    const mod = hasuraEvent.defineEvent({ name: 'scoped.event', detector: detector as never, jobs: [() => 'ok'] });
    expect(String(mod.name)).toBe('scoped.event');
    expect(mod.detector).toBe(detector);
    expect(mod.jobs).toHaveLength(1);
  });

  it('a scoped module runs end-to-end: the inline detector receives the ENRICHED runtime ctx', async () => {
    const seen: string[] = [];
    interface Row {
      id: number;
      status: string;
    }
    const kit = createEventKit(hasuraEvent).registerEvent(
      hasuraEvent.defineEvent<Row>({
        name: 'order.status.ready',
        // bare inline arrow — at runtime ctx must carry the Hasura enrichment
        detector: ctx => ctx.operation === 'UPDATE' && ctx.columnChanged('status') && ctx.newRow?.status === 'ready',
        prepare: ctx => ({ orderId: ctx.newRow?.id }),
        jobs: [ctx => void seen.push(`ran:${(ctx.input as { orderId?: number }).orderId}`)],
      }),
    );

    const fired = await kit.handle(hasuraUpdate('orders', { id: 7, status: 'pending' }, { id: 7, status: 'ready' }));
    expect(fired.events.map(e => ({ name: e.name, detected: e.detected }))).toEqual([
      { name: 'order.status.ready', detected: true },
    ]);
    expect(seen).toEqual(['ran:7']);

    // Non-matching update: detector (with its enriched helpers) declines cleanly.
    const quiet = await kit.handle(hasuraUpdate('orders', { id: 8, status: 'ready' }, { id: 8, status: 'ready' }));
    expect(quiet.events).toEqual([]);
  });
});
