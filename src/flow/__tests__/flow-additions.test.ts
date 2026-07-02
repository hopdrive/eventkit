// Wave 3 flow additions (ADR-037): toFlowMermaid, the effects schema + repo/function
// reservation, and kit.dryRun (detection only).
import { describe, it, expect } from 'vitest';
import { createEventKit, defineEvent, job } from '../../index.js';
import { hasuraEvent } from '../../plugins/source-hasura.js';
import { hasuraInsert } from '../../testing/index.js';
import { toFlowGraph, toFlowYaml, toFlowMermaid } from '../graph.js';

const effectKit = () =>
  createEventKit(hasuraEvent).registerEvents([
    defineEvent({
      name: 'move.created',
      detector: hasuraEvent.detector<{ status?: string }>(ctx => ctx.operation === 'INSERT' && ctx.newRow?.status === 'new'),
      jobs: [
        job(() => {}, { name: 'writeLedger', metadata: { effects: [{ type: 'db-write', table: 'ledger' }] } }),
        job(() => {}, { name: 'callVendor', metadata: { effects: [{ type: 'api-call', vendor: 'uber' }] } }),
        job(() => {}, { name: 'legacySms', metadata: { sideEffect: 'sms' } }),
      ],
    }),
  ]);

describe('toFlowGraph: effects schema (ADR-037) + repo/function origin', () => {
  it('emits a sideEffect node per declared effect, incl. the legacy sideEffect string', () => {
    const { nodes, edges } = toFlowGraph(effectKit());
    const effects = nodes.filter(n => n.kind === 'sideEffect');
    expect(effects).toHaveLength(3);
    // effect metadata is preserved verbatim for a future aggregator
    const dbWrite = effects.find(n => (n.metadata?.['effect'] as { table?: string })?.table === 'ledger');
    expect(dbWrite).toBeDefined();
    const apiCall = effects.find(n => (n.metadata?.['effect'] as { vendor?: string })?.vendor === 'uber');
    expect(apiCall).toBeDefined();
    // each effect is edged from its job
    expect(edges.some(e => e.from === 'job:move.created:callVendor' && e.to.startsWith('sideEffect:callVendor:'))).toBe(true);
  });

  it('stamps repo/function on the source node when origin is supplied', () => {
    const { nodes } = toFlowGraph(effectKit(), { repo: 'db-moves', function: 'moves-event' });
    const source = nodes.find(n => n.kind === 'source');
    expect(source?.metadata).toEqual({ repo: 'db-moves', function: 'moves-event' });
  });
});

describe('toFlowYaml: repo/function reservation', () => {
  it('includes repo/function only when supplied', () => {
    const withOrigin = toFlowYaml(effectKit(), { repo: 'db-moves', function: 'moves-event' });
    expect(withOrigin).toMatch(/repo: db-moves/);
    expect(withOrigin).toMatch(/function: moves-event/);
    const without = toFlowYaml(effectKit());
    expect(without).not.toMatch(/repo:/);
  });
});

describe('toFlowMermaid', () => {
  it('emits a flowchart with source, event, job, and sideEffect nodes + edges', () => {
    const mermaid = toFlowMermaid(effectKit());
    expect(mermaid.startsWith('flowchart TD')).toBe(true);
    expect(mermaid).toContain('move.created');
    expect(mermaid).toContain('writeLedger');
    expect(mermaid).toContain('db-write:ledger');
    expect(mermaid).toContain('-->'); // has edges
  });
});

describe('kit.dryRun: detection only, no jobs', () => {
  it('reports which events would fire and the jobs they would dispatch', async () => {
    let jobRan = false;
    const kit = createEventKit(hasuraEvent).registerEvents([
      defineEvent({
        name: 'move.created',
        detector: hasuraEvent.detector<{ status?: string }>(ctx => ctx.operation === 'INSERT' && ctx.newRow?.status === 'new'),
        jobs: [job(() => { jobRan = true; }, { name: 'writeLedger' })],
      }),
    ]);
    const dry = await kit.dryRun(hasuraInsert('moves', { status: 'new' }));
    expect(dry.events).toHaveLength(1);
    expect(dry.events[0]!.name).toBe('move.created');
    expect(dry.events[0]!.detected).toBe(true);
    expect(dry.events[0]!.jobs).toEqual(['writeLedger']);
    expect(jobRan).toBe(false); // dryRun must NOT run jobs
  });

  it('omits events whose detector does not match', async () => {
    const kit = createEventKit(hasuraEvent).registerEvents([
      defineEvent({
        name: 'move.created',
        detector: hasuraEvent.detector<{ status?: string }>(ctx => ctx.newRow?.status === 'new'),
        jobs: [job(() => {}, { name: 'x' })],
      }),
    ]);
    const dry = await kit.dryRun(hasuraInsert('moves', { status: 'pending' }));
    expect(dry.events).toHaveLength(0);
  });
});
