// Parse a committed eventkit flow doc (YAML from `eventkit-flow generate`, or the
// JSON form of toFlowGraph) into a FlowGraph, using the SAME id builders as
// @hopdrive/eventkit/flow (graph.ts) so Observed records line up by name.

import { parse as parseYaml } from 'yaml';
import type { FlowDoc, FlowGraph, FlowGraphEdge, FlowGraphNode } from './types';

const SOURCE_ID = 'source';
export const eventNodeId = (name: string): string => `event:${name}`;
export const jobNodeId = (event: string, job: string): string => `job:${event}:${job}`;
const sideEffectNodeId = (job: string, effect: string): string => `sideEffect:${job}:${effect}`;

interface YamlJob {
  name: string;
  retries?: number;
  metadata?: Record<string, unknown>;
  continueOnFailure?: boolean;
}
interface YamlEvent {
  name: string;
  description?: string;
  owner?: string;
  response?: string;
  flowHints?: Record<string, unknown>;
  jobs?: YamlJob[];
}
interface YamlDoc {
  generator?: string;
  schema?: number;
  title?: string;
  kit?: { source?: { name?: string; type?: string }; platform?: string; plugins?: string[] };
  events?: YamlEvent[];
  // toFlowGraph JSON form
  nodes?: unknown[];
  edges?: unknown[];
}

function graphFromEvents(sourceName: string, events: YamlEvent[]): FlowGraph {
  const nodes: FlowGraphNode[] = [{ id: SOURCE_ID, kind: 'source', label: sourceName, sourceFunction: sourceName }];
  const edges: FlowGraphEdge[] = [];

  for (const ev of events) {
    const evId = eventNodeId(ev.name);
    nodes.push({
      id: evId,
      kind: 'event',
      label: ev.name,
      eventName: ev.name,
      ...(ev.description ? { description: ev.description } : {}),
      ...(ev.owner ? { owner: ev.owner } : {}),
      ...(ev.response && ev.response !== 'none' ? { response: ev.response } : {}),
      ...(ev.flowHints ? { flowHints: ev.flowHints } : {}),
    });
    edges.push({ from: SOURCE_ID, to: evId });

    for (const j of ev.jobs ?? []) {
      const jId = jobNodeId(ev.name, j.name);
      nodes.push({
        id: jId,
        kind: 'job',
        label: j.name,
        jobName: j.name,
        ...(typeof j.retries === 'number' ? { retries: j.retries } : {}),
      });
      edges.push(j.continueOnFailure === false ? { from: evId, to: jId, required: true } : { from: evId, to: jId });

      const effect = j.metadata?.['sideEffect'];
      if (typeof effect === 'string' && effect) {
        const seId = sideEffectNodeId(j.name, effect);
        nodes.push({ id: seId, kind: 'sideEffect', label: effect, sideEffect: effect });
        edges.push({ from: jId, to: seId });
      }
    }
  }
  return { nodes, edges };
}

/** Parse YAML (event-centric committed doc) or JSON ({nodes,edges}) text. Throws with a readable message. */
export function parseFlowDoc(raw: string, origin: FlowDoc['origin']): FlowDoc {
  let doc: YamlDoc;
  try {
    doc = raw.trimStart().startsWith('{') ? JSON.parse(raw) : parseYaml(raw);
  } catch (e) {
    throw new Error(`Not valid YAML/JSON: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== 'object') throw new Error('Empty flow doc.');

  if (Array.isArray(doc.events)) {
    const sourceName = doc.kit?.source?.name ?? 'source';
    const graph = graphFromEvents(sourceName, doc.events);
    return {
      title: doc.title ?? 'untitled flow',
      sourceName,
      sourceType: doc.kit?.source?.type,
      platform: doc.kit?.platform,
      plugins: doc.kit?.plugins,
      graph,
      origin,
      raw,
    };
  }

  // toFlowGraph JSON: normalize into FlowGraphNode (label from name fields)
  if (Array.isArray(doc.nodes) && Array.isArray(doc.edges)) {
    const nodes = (doc.nodes as Record<string, unknown>[]).map(n => ({
      id: String(n.id),
      kind: (n.kind as FlowGraphNode['kind']) ?? 'event',
      label: String(n.eventName ?? n.jobName ?? n.sourceFunction ?? (n.metadata as any)?.sideEffect ?? n.id),
      eventName: n.eventName as string | undefined,
      jobName: n.jobName as string | undefined,
      sourceFunction: n.sourceFunction as string | undefined,
    }));
    const edges = (doc.edges as Record<string, unknown>[]).map(e => ({
      from: String(e.from),
      to: String(e.to),
      ...(e.required ? { required: true } : {}),
    }));
    return { title: 'flow graph', sourceName: 'source', graph: { nodes, edges }, origin, raw };
  }

  throw new Error('Unrecognized flow doc shape — expected eventkit-flow YAML (events:) or a {nodes,edges} JSON graph.');
}
