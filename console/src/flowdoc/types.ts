// Expected-flow + Compare vocabulary for the console.
//
// Mirrors @hopdrive/eventkit/flow (ADR-032): node ids are name-derived
// (`source`, `event:<name>`, `job:<event>:<job>`, `sideEffect:<job>:<effect>`)
// so Expected and Observed line up (docs/planning/console-expected-flows.md §4).
// The matcher classifications are §3's vocabulary. D-console-1: the matcher here
// is a pure function intended to move INTO @hopdrive/eventkit/flow so CI and the
// console share one implementation — keep it dependency-free.

export type FlowNodeKind = 'source' | 'event' | 'job' | 'sideEffect' | 'terminal';

export interface FlowGraphNode {
  id: string;
  kind: FlowNodeKind;
  label: string;
  /** kind-specific extras straight from the flow doc */
  eventName?: string;
  jobName?: string;
  sourceFunction?: string;
  description?: string;
  owner?: string;
  flowHints?: Record<string, unknown>;
  sideEffect?: string;
  retries?: number;
  response?: string;
}

export interface FlowGraphEdge {
  from: string;
  to: string;
  required?: boolean;
}

export interface FlowGraph {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
}

/** A parsed committed flow doc (eventkit-flow generate output). */
export interface FlowDoc {
  title: string;
  sourceName: string;
  sourceType?: string;
  platform?: string;
  plugins?: string[];
  graph: FlowGraph;
  /** where it came from — bundled sample or user upload */
  origin: 'bundled' | 'uploaded';
  raw: string;
}

// §3 classification vocabulary, carried verbatim. `observed_running` is a console
// extension for still-executing runs (the doc's `retrying` implies attempt
// awareness the records don't carry yet).
export type CompareClassification =
  | 'expected_missing'
  | 'optional_not_taken'
  | 'condition_not_met'
  | 'observed_success'
  | 'observed_failed'
  | 'observed_running'
  | 'unexpected_observed'
  | 'retrying'
  | 'timed_out'
  | 'cancelled'
  | 'out_of_order'
  | 'extra_invocation_chain';

export type MatchConfidence = 'exact' | 'inferred' | 'unmatched';

export interface NodeVerdict {
  classification: CompareClassification;
  confidence: MatchConfidence;
  /** short human detail, e.g. "3 runs, 1 failed" or "no observed execution" */
  detail?: string;
  /** observed ids backing the verdict (event_execution / job_execution ids) */
  observedIds?: string[];
}

export interface CompareResult {
  /** verdicts keyed by expected-graph node id */
  verdicts: Record<string, NodeVerdict>;
  /** observed activity with no expected home — grafted as extra nodes/edges */
  extraNodes: FlowGraphNode[];
  extraEdges: FlowGraphEdge[];
  /** verdicts for the grafted extras (always unexpected_observed) */
  extraVerdicts: Record<string, NodeVerdict>;
  summary: {
    expectedTotal: number;
    matched: number;
    missing: number;
    failed: number;
    unexpected: number;
  };
}
