// The Compare matcher — Observed overlaid on Expected, classified.
//
// Implements console-expected-flows.md §3 with the doc's two hard rules:
// preserve uncertainty (matchConfidence) and NEVER hide an unmatched observed
// node — extras are grafted into the graph as first-class unexpected_observed
// nodes, not dropped or tucked into a tray. Matching is name-keyed (§4):
// event_executions.event_name -> event:<name>; job under it -> job:<event>:<job>.
//
// D-console-1: pure + dependency-free on purpose, so it can be upstreamed into
// @hopdrive/eventkit/flow and shared with CI verbatim.

import { eventNodeId, jobNodeId } from './parseFlowDoc';
import type { CompareResult, FlowGraph, FlowGraphEdge, FlowGraphNode, NodeVerdict } from './types';

/** The slice of the InvocationTreeFlow result the matcher needs (kept structural
 *  so generated types plug in without coupling). */
export interface ObservedInvocation {
  id: string;
  status?: string | null;
  event_executions?: Array<{
    id: string;
    event_name: string;
    detected?: boolean | null;
    status?: string | null;
    handler_error?: string | null;
    job_executions?: Array<{
      id: string;
      job_name: string;
      status?: string | null;
    }> | null;
  }> | null;
}

interface Occurrence {
  ids: string[];
  completed: number;
  failed: number;
  running: number;
}

const occur = (): Occurrence => ({ ids: [], completed: 0, failed: 0, running: 0 });

function tally(o: Occurrence, id: string, status: string | null | undefined) {
  o.ids.push(id);
  if (status === 'failed' || status === 'handler_failed' || status === 'detection_failed') o.failed++;
  else if (status === 'running' || status === 'handling' || status === 'detecting') o.running++;
  else o.completed++;
}

function verdictFor(o: Occurrence | undefined, kindLabel: string): NodeVerdict {
  if (!o || o.ids.length === 0) {
    return { classification: 'expected_missing', confidence: 'unmatched', detail: `no observed ${kindLabel}` };
  }
  const detail =
    o.ids.length === 1
      ? undefined
      : `${o.ids.length} runs — ${o.failed} failed, ${o.running} running`;
  if (o.failed > 0) return { classification: 'observed_failed', confidence: 'exact', detail, observedIds: o.ids };
  if (o.running > 0) return { classification: 'observed_running', confidence: 'exact', detail, observedIds: o.ids };
  return { classification: 'observed_success', confidence: 'exact', detail, observedIds: o.ids };
}

/**
 * Overlay one run's observed tree (root invocation + its correlation group) onto
 * an expected FlowGraph.
 */
export function compareFlow(expected: FlowGraph, observed: ObservedInvocation[]): CompareResult {
  // 1. Collapse the observed tree into name-keyed occurrences.
  const events = new Map<string, Occurrence>(); // event:<name>
  const jobs = new Map<string, Occurrence>(); // job:<event>:<job>

  for (const inv of observed) {
    for (const ev of inv.event_executions ?? []) {
      if (!ev.detected) continue; // undetected = the detector said "not this event"; not activity
      const evKey = eventNodeId(ev.event_name);
      const eo = events.get(evKey) ?? occur();
      tally(eo, ev.id, ev.handler_error ? 'failed' : ev.status);
      events.set(evKey, eo);

      for (const j of ev.job_executions ?? []) {
        const jKey = jobNodeId(ev.event_name, j.job_name);
        const jo = jobs.get(jKey) ?? occur();
        tally(jo, j.id, j.status);
        jobs.set(jKey, jo);
      }
    }
  }

  // 2. Verdict per expected node.
  const verdicts: Record<string, NodeVerdict> = {};
  const expectedIds = new Set(expected.nodes.map(n => n.id));
  for (const node of expected.nodes) {
    if (node.kind === 'source') {
      verdicts[node.id] = observed.length
        ? { classification: 'observed_success', confidence: 'exact', detail: `${observed.length} invocation(s)` }
        : { classification: 'expected_missing', confidence: 'unmatched' };
    } else if (node.kind === 'event') {
      verdicts[node.id] = verdictFor(events.get(node.id), 'detection');
    } else if (node.kind === 'job') {
      verdicts[node.id] = verdictFor(jobs.get(node.id), 'execution');
    } else {
      // sideEffect/terminal: inferred from the owning job's verdict (no direct record).
      const owner = expected.edges.find(e => e.to === node.id)?.from;
      const ov = owner ? verdicts[owner] : undefined;
      verdicts[node.id] = ov
        ? { ...ov, confidence: 'inferred', detail: 'inferred from owning job' }
        : { classification: 'expected_missing', confidence: 'unmatched' };
    }
  }

  // 3. Graft unmatched observed activity as unexpected_observed (§3: a finding, not noise).
  const extraNodes: FlowGraphNode[] = [];
  const extraEdges: FlowGraphEdge[] = [];
  const extraVerdicts: Record<string, NodeVerdict> = {};

  for (const [evKey, eo] of events) {
    if (expectedIds.has(evKey)) continue;
    const name = evKey.slice('event:'.length);
    extraNodes.push({ id: evKey, kind: 'event', label: name, eventName: name });
    extraEdges.push({ from: 'source', to: evKey });
    extraVerdicts[evKey] = { classification: 'unexpected_observed', confidence: 'exact', observedIds: eo.ids };
  }
  for (const [jKey, jo] of jobs) {
    if (expectedIds.has(jKey)) continue;
    const [, evName, jobName] = jKey.split(':');
    extraNodes.push({ id: jKey, kind: 'job', label: jobName, jobName });
    const parent = eventNodeId(evName);
    extraEdges.push({ from: expectedIds.has(parent) || extraVerdicts[parent] ? parent : 'source', to: jKey });
    extraVerdicts[jKey] = { classification: 'unexpected_observed', confidence: 'exact', observedIds: jo.ids };
  }

  // 4. Summary chips.
  const vs = Object.values(verdicts);
  return {
    verdicts,
    extraNodes,
    extraEdges,
    extraVerdicts,
    summary: {
      expectedTotal: expected.nodes.length,
      matched: vs.filter(v => v.classification === 'observed_success' || v.classification === 'observed_running').length,
      missing: vs.filter(v => v.classification === 'expected_missing').length,
      failed: vs.filter(v => v.classification === 'observed_failed').length,
      unexpected: extraNodes.length,
    },
  };
}
