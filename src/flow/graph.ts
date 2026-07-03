// Flow generators (§14–§16). Given a built kit, produce:
//   • describeKit(kit)  — the raw structural snapshot (delegates to kit.describe()).
//   • toFlowGraph(kit)  — a { nodes, edges } graph in the FlowNode/FlowEdge
//                         vocabulary, so it can be diffed against a hand-authored
//                         manifest or fed to React Flow.
//   • toFlowYaml(kit)   — the human-readable, diff-friendly committed document,
//                         event-centric, with a @generated banner.
// All three are pure: they run nothing on the kit but a read-only registry walk.
import type { EventKit, FlowEdge, FlowNode, JobEffect, KitDescription, KitJobDescription } from '../core/index.js';
import { toYaml } from './yaml.js';

/** The structural snapshot of a built kit. */
export function describeKit(kit: EventKit): KitDescription {
  return kit.describe();
}

/** Identify the kit's place in the org topology — reserved for a future cross-kit aggregator (ADR-037). */
export interface FlowOrigin {
  /** The repo this kit lives in (e.g. `'db-appointments'`). */
  repo?: string;
  /** The function/deployment this kit is the handler for (e.g. `'appointments-event'`). */
  function?: string;
}

const SOURCE_ID = 'source';
const eventId = (name: string): string => `event:${name}`;
const jobId = (event: string, job: string): string => `job:${event}:${job}`;
const sideEffectId = (job: string, effect: string): string => `sideEffect:${job}:${effect}`;

/**
 * Shared node-id builders. Every producer of a flow graph — the generator here, and the
 * proto-Compare check that overlays observed runtime records — MUST derive ids the same
 * way, or the observed-vs-expected overlay won't line up (console-expected-flows.md §4).
 */
export const flowNodeId = {
  source: SOURCE_ID,
  event: eventId,
  job: jobId,
  sideEffect: sideEffectId,
} as const;

/** Stable label for a declared effect (`db-write:moves`, `api-call:uber`, or the bare type). */
const effectLabel = (e: JobEffect): string => {
  if (e.type === 'db-write' && typeof (e as { table?: unknown }).table === 'string') return `db-write:${(e as { table: string }).table}`;
  if (e.type === 'api-call' && typeof (e as { vendor?: unknown }).vendor === 'string') return `api-call:${(e as { vendor: string }).vendor}`;
  return String(e.type);
};

/** Read a job's declared effects from the `metadata.effects` array (ADR-037). */
function jobEffects(j: KitJobDescription): JobEffect[] {
  const raw = j.metadata?.['effects'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((e): e is JobEffect => !!e && typeof e === 'object' && typeof (e as { type?: unknown }).type === 'string');
}

/**
 * A `{ nodes, edges }` graph in the manifest vocabulary: one `source` node, an
 * `event` node per registered event (edge source→event), a `job` node per job
 * (edge event→job), and a `sideEffect` node per declared effect (edge job→sideEffect).
 * Node ids are derived from event/job names (never file paths), so they are stable
 * across refactors (§14). Effects come from `metadata.effects` (`{type:'db-write',table}`
 * / `{type:'api-call',vendor}` — ADR-037) or the legacy `metadata.sideEffect` string.
 * Pass `origin` to stamp the source node with the reserved `repo`/`function` topology.
 */
export function toFlowGraph(kit: EventKit, origin: FlowOrigin = {}): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const d = kit.describe();
  const sourceNode: FlowNode = { id: SOURCE_ID, kind: 'source', sourceFunction: d.source.name };
  if (origin.repo !== undefined || origin.function !== undefined) {
    sourceNode.metadata = {
      ...(origin.repo !== undefined ? { repo: origin.repo } : {}),
      ...(origin.function !== undefined ? { function: origin.function } : {}),
    };
  }
  const nodes: FlowNode[] = [sourceNode];
  const edges: FlowEdge[] = [];

  for (const ev of d.events) {
    const evId = eventId(ev.name);
    const evNode: FlowNode = { id: evId, kind: 'event', eventName: ev.name };
    if (ev.flowHints) evNode.metadata = { flowHints: ev.flowHints };
    nodes.push(evNode);
    edges.push({ from: SOURCE_ID, to: evId });

    for (const j of ev.jobs) {
      const jId = jobId(ev.name, j.name);
      nodes.push({ id: jId, kind: 'job', jobName: j.name });
      // continueOnFailure:false marks a job the run treats as required (stops the batch).
      edges.push(j.continueOnFailure === false ? { from: evId, to: jId, required: true } : { from: evId, to: jId });

      // New structured effects (ADR-037) → node metadata { effect }.
      for (const effect of jobEffects(j)) {
        const seId = sideEffectId(j.name, effectLabel(effect));
        nodes.push({ id: seId, kind: 'sideEffect', metadata: { effect } });
        edges.push({ from: jId, to: seId });
      }
      // Legacy `metadata.sideEffect` string → node metadata { sideEffect } (unchanged shape).
      const legacy = j.metadata?.['sideEffect'];
      if (typeof legacy === 'string' && legacy) {
        const seId = sideEffectId(j.name, legacy);
        nodes.push({ id: seId, kind: 'sideEffect', metadata: { sideEffect: legacy } });
        edges.push({ from: jId, to: seId });
      }
    }
  }

  return { nodes, edges };
}

/**
 * A Mermaid `flowchart` of the kit's structure (source → event → job → sideEffect),
 * diff-readable in a PR and renderable inline in GitHub/docs. Node ids are sanitized
 * (Mermaid-safe), labels carry the human name. Not a full HTML emitter (out of scope).
 */
export function toFlowMermaid(kit: EventKit, origin: FlowOrigin = {}): string {
  const { nodes, edges } = toFlowGraph(kit, origin);
  const safe = (id: string): string => 'n_' + id.replace(/[^A-Za-z0-9_]/g, '_');
  const esc = (s: string): string => s.replace(/"/g, '&quot;');
  // node shape by kind: source [( )], event [ ], job ( ), sideEffect { }
  const effectLabelOf = (n: FlowNode): string | undefined => {
    if (n.metadata?.['effect']) return effectLabel(n.metadata['effect'] as JobEffect);
    if (typeof n.metadata?.['sideEffect'] === 'string') return n.metadata['sideEffect'] as string;
    return undefined;
  };
  const shape = (n: FlowNode): string => {
    const label = esc(n.eventName ?? n.jobName ?? effectLabelOf(n) ?? n.sourceFunction ?? n.id);
    switch (n.kind) {
      case 'source': return `${safe(n.id)}([${label}])`;
      case 'event': return `${safe(n.id)}["${label}"]`;
      case 'job': return `${safe(n.id)}("${label}")`;
      case 'sideEffect': return `${safe(n.id)}{{"${label}"}}`;
      default: return `${safe(n.id)}["${label}"]`;
    }
  };
  const lines = ['flowchart TD'];
  for (const n of nodes) lines.push(`  ${shape(n)}`);
  for (const e of edges) lines.push(`  ${safe(e.from)} --> ${safe(e.to)}`);
  return lines.join('\n') + '\n';
}

const BANNER = [
  '# @generated by @hopdrive/eventkit/flow — DO NOT EDIT BY HAND.',
  '# Regenerate with:  npx eventkit-flow generate --kit <module> --out <file>',
  '# CI drift check:   npx eventkit-flow check    --kit <module> --out <file>',
  '#',
  '# Documents the STRUCTURE of events registered on the kit (source -> event -> jobs),',
  '# derived from the declarative modules. Business MEANING (cross-event chains, intent)',
  '# belongs in a hand-authored flow manifest — see docs (§15).',
];

/**
 * The committed, human-readable flow document. Event-centric and deterministic so
 * a PR diff reads naturally. Pass a `title` to label the doc (e.g. the function name).
 */
export function toFlowYaml(kit: EventKit, opts: { title?: string } & FlowOrigin = {}): string {
  const d = kit.describe();

  const kitBlock: Record<string, unknown> = {
    source: { name: d.source.name, type: d.source.type },
  };
  // Reserved topology (ADR-037) — present only when supplied, so existing docs don't churn.
  if (opts.repo !== undefined) kitBlock['repo'] = opts.repo;
  if (opts.function !== undefined) kitBlock['function'] = opts.function;
  if (d.platform) kitBlock['platform'] = d.platform;
  kitBlock['plugins'] = d.plugins;

  const events = d.events.map(ev => {
    const out: Record<string, unknown> = { name: ev.name, response: ev.response };
    if (ev.description) out['description'] = ev.description;
    if (ev.owner) out['owner'] = ev.owner;
    if (ev.tags) out['tags'] = ev.tags;
    if (ev.deprecated) out['deprecated'] = true;
    if (ev.runMode) out['runMode'] = ev.runMode;
    if (ev.flowHints) out['flowHints'] = ev.flowHints as Record<string, unknown>;
    out['jobs'] = ev.jobs.map(j => {
      const jo: Record<string, unknown> = { name: j.name };
      if (j.retries !== undefined) jo['retries'] = j.retries;
      if (j.timeoutMs !== undefined) jo['timeoutMs'] = j.timeoutMs;
      if (j.continueOnFailure !== undefined) jo['continueOnFailure'] = j.continueOnFailure;
      if (j.tags) jo['tags'] = j.tags;
      if (j.metadata) jo['metadata'] = j.metadata;
      return jo;
    });
    return out;
  });

  const doc: Record<string, unknown> = { generator: '@hopdrive/eventkit/flow', schema: 1 };
  if (opts.title) doc['title'] = opts.title;
  doc['kit'] = kitBlock;
  doc['events'] = events;

  return BANNER.join('\n') + '\n' + toYaml(doc);
}
