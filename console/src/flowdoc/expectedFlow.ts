// Adapt the host-injected ExpectedFlowGraph (the toFlowGraph() wire contract, see
// config.tsx) into the console's internal FlowGraph so it can be rendered and fed
// to compareFlow. This is a pure, lossless normalization: the wire shape carries
// name fields (eventName/jobName/sourceFunction) and the console shape wants a
// display `label`, so the only work here is deriving that label. Node ids are
// carried through verbatim — they already follow the shared name-derived scheme.

import type { ExpectedFlowGraph, ExpectedFlowNode } from '../config';
import type { FlowGraph, FlowGraphEdge, FlowGraphNode, FlowNodeKind } from './types';

const CONSOLE_KINDS: ReadonlySet<FlowNodeKind> = new Set(['source', 'event', 'job', 'sideEffect', 'terminal']);

/** The console's node vocabulary is narrower than the contract's (no invocation/handler);
 *  a producer only ever emits source/event/job/sideEffect from toFlowGraph, so anything
 *  outside the set renders as a plain event rather than being dropped. */
function toConsoleKind(kind: ExpectedFlowNode['kind']): FlowNodeKind {
  return CONSOLE_KINDS.has(kind as FlowNodeKind) ? (kind as FlowNodeKind) : 'event';
}

function labelFor(n: ExpectedFlowNode): string {
  if (n.eventName) return n.eventName;
  if (n.jobName) return n.jobName;
  if (n.sourceFunction) return n.sourceFunction;
  const effect = n.metadata?.['effect'];
  if (effect && typeof effect === 'object') {
    const e = effect as { type?: unknown; table?: unknown; vendor?: unknown };
    if (e.type === 'db-write' && typeof e.table === 'string') return `db-write:${e.table}`;
    if (e.type === 'api-call' && typeof e.vendor === 'string') return `api-call:${e.vendor}`;
    if (typeof e.type === 'string') return e.type;
  }
  const legacy = n.metadata?.['sideEffect'];
  if (typeof legacy === 'string' && legacy) return legacy;
  return n.id;
}

/** Convert an ExpectedFlowGraph (the wire contract) into the console's FlowGraph. */
export function expectedFlowToGraph(graph: ExpectedFlowGraph): FlowGraph {
  const nodes: FlowGraphNode[] = graph.nodes.map(n => ({
    id: n.id,
    kind: toConsoleKind(n.kind),
    label: labelFor(n),
    ...(n.eventName ? { eventName: n.eventName } : {}),
    ...(n.jobName ? { jobName: n.jobName } : {}),
    ...(n.sourceFunction ? { sourceFunction: n.sourceFunction } : {}),
    ...(typeof n.metadata?.['sideEffect'] === 'string' ? { sideEffect: n.metadata['sideEffect'] as string } : {}),
  }));
  const edges: FlowGraphEdge[] = graph.edges.map(e => ({
    from: e.from,
    to: e.to,
    ...(e.required ? { required: true } : {}),
  }));
  return { nodes, edges };
}
