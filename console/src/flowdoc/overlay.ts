// Per-invocation expected-flow overlay.
//
// For each invocation on the canvas, its source_function resolves (via the
// host-injected resolver) to an expected FlowGraph. This overlays that graph on
// the invocation's OWN observed records using compareFlow (the same name-keyed
// matcher + shared node-id builders as everywhere else):
//   • expected_missing  -> a ghost node (dashed, muted) attached under the
//                          invocation, "expected by the flow definition, not observed".
//   • unexpected_observed -> the id of the observed node gets flagged off-contract
//                          (a small badge on the EXISTING node; no new node).
//   • matched -> untouched.
// An invocation whose function resolves to null (or is absent from the map) is
// skipped entirely, so absence of a flow is never a judgement.
//
// This is a display transform only: it adds ghost nodes/edges and returns a set of
// off-contract node ids; it never mutates or removes an observed node.

import type { Edge, Node } from 'reactflow';
import { compareFlow, type ObservedInvocation } from './compare';
import type { FlowGraph } from './types';

/** An observed invocation plus the one field compareFlow doesn't need but the overlay does. */
export type OverlayInvocation = ObservedInvocation & { source_function?: string | null };

export interface OverlayInput {
  /** Positioned observed nodes already on the canvas (invocation/event/job/...). */
  observedNodes: Node[];
  observedEdges: Edge[];
  invocations: OverlayInvocation[];
  /** sourceFunction -> expected graph (only functions with a resolved flow). */
  flowByFunction: Record<string, FlowGraph>;
}

export interface OverlayResult {
  ghostNodes: Node[];
  ghostEdges: Edge[];
  /** Observed node ids to mark off-contract (present in the run, absent from the flow). */
  offContractNodeIds: Set<string>;
  /** Rollup for the legend/summary pill. */
  summary: { missing: number; offContract: number; invocationsOverlaid: number };
}

const GHOST_EDGE_STYLE = { strokeDasharray: '6 4', stroke: '#9ca3af', strokeWidth: 1.5 };
const GHOST_TOOLTIP = 'Expected by the flow definition, not observed on this invocation.';
// Vertical step between stacked ghost events, and node-height estimates used to find
// where an invocation's observed subtree ends so ghosts stack below it, not over it.
const GHOST_ROW = 140;
const H = { invocation: 84, event: 84, job: 102 };

const nodeBottom = (n: Node): number => n.position.y + (H[n.type as keyof typeof H] ?? 84);

/** Build the ghost nodes/edges and off-contract set for every invocation with a flow. */
export function buildExpectedOverlay(input: OverlayInput): OverlayResult {
  const { observedNodes, observedEdges, invocations, flowByFunction } = input;
  const ghostNodes: Node[] = [];
  const ghostEdges: Edge[] = [];
  const offContractNodeIds = new Set<string>();
  let missing = 0;
  let overlaid = 0;

  const byId = new Map(observedNodes.map(n => [n.id, n]));
  // Observed event/job nodes grouped under the invocation that owns them, by walking
  // the observed edges (invocation -> event-<id> -> job-<id>).
  const childrenOf = (id: string): Node[] =>
    observedEdges.filter(e => e.source === id).map(e => byId.get(e.target)).filter((n): n is Node => !!n);

  for (const inv of invocations) {
    const fn = inv.source_function ?? undefined;
    const graph = fn ? flowByFunction[fn] : undefined;
    const invNode = byId.get(inv.id);
    if (!graph || !invNode) continue;

    const result = compareFlow(graph, [inv]);
    overlaid++;

    // Off-contract: observed events/jobs this invocation ran that the flow doesn't
    // declare. Map the matcher's extra ids (name-keyed) back to the canvas nodes.
    const observedEvents = childrenOf(inv.id).filter(n => n.type === 'event');
    const extraEventNames = new Set<string>();
    const extraJobNames = new Set<string>();
    for (const key of Object.keys(result.extraVerdicts)) {
      if (key.startsWith('event:')) extraEventNames.add(key.slice('event:'.length));
      else if (key.startsWith('job:')) extraJobNames.add(key.split(':')[2]);
    }
    for (const en of observedEvents) {
      if (extraEventNames.has(en.data?.eventName)) offContractNodeIds.add(en.id);
      for (const jn of childrenOf(en.id).filter(n => n.type === 'job')) {
        if (extraJobNames.has(jn.data?.jobName)) offContractNodeIds.add(jn.id);
      }
    }

    // Ghosts: expected nodes with no observed home on THIS invocation. Stack them
    // below the invocation's observed subtree, in the observed event/job columns.
    const subtree = [invNode, ...observedEvents, ...observedEvents.flatMap(en => childrenOf(en.id))];
    const eventX = observedEvents[0]?.position.x ?? invNode.position.x + 530;
    const jobX = eventX + 450;
    let y = Math.max(...subtree.map(nodeBottom)) + 60;

    const isMissing = (id: string): boolean => result.verdicts[id]?.classification === 'expected_missing';

    for (const gn of graph.nodes) {
      if (gn.kind !== 'event' || !isMissing(gn.id)) continue;
      const name = gn.eventName ?? gn.label;
      const gEventId = `ghost-flow:${inv.id}:${gn.id}`;
      ghostNodes.push({
        id: gEventId,
        type: 'event',
        selected: false,
        position: { x: eventX, y },
        data: {
          eventName: name,
          ghost: true,
          ghostLabel: 'expected · not observed',
          ghostTone: 'neutral',
          ghostTitle: GHOST_TOOLTIP,
          detected: false,
          correlationId: '',
          status: '',
          detectionDuration: 0,
          jobsCount: 0,
          hasFailedJobs: false,
        },
      });
      ghostEdges.push({ id: `${gEventId}-edge`, source: inv.id, target: gEventId, animated: false, style: GHOST_EDGE_STYLE });
      missing++;

      let jy = y;
      for (const je of graph.edges.filter(e => e.from === gn.id)) {
        const jobNode = graph.nodes.find(n => n.id === je.to && n.kind === 'job');
        if (!jobNode || !isMissing(jobNode.id)) continue;
        const gJobId = `ghost-flow:${inv.id}:${jobNode.id}`;
        ghostNodes.push({
          id: gJobId,
          type: 'job',
          selected: false,
          position: { x: jobX, y: jy },
          data: {
            jobName: jobNode.jobName ?? jobNode.label,
            ghost: true,
            ghostTitle: GHOST_TOOLTIP,
            correlationId: '',
            status: '',
            duration: 0,
          },
        });
        ghostEdges.push({ id: `${gJobId}-edge`, source: gEventId, target: gJobId, animated: false, style: GHOST_EDGE_STYLE });
        missing++;
        jy += 110;
      }
      y = Math.max(y + GHOST_ROW, jy + 30);
    }
  }

  return {
    ghostNodes,
    ghostEdges,
    offContractNodeIds,
    summary: { missing, offContract: offContractNodeIds.size, invocationsOverlaid: overlaid },
  };
}
