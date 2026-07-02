// Expected + Compare rendering for the flow canvas.
//
// Expected mode draws the committed flow doc's structure (source -> events ->
// jobs -> sideEffects) as the canonical shape of the process. Compare mode colors
// each node by the matcher's classification (§3) and grafts unexpected observed
// activity into the same canvas. One layered layout for both.

import React, { memo, useMemo } from 'react';
import ReactFlow, { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlowProvider } from 'reactflow';
import type { Edge, Node, NodeProps } from 'reactflow';
import type { CompareClassification, CompareResult, FlowDoc, FlowGraphNode, NodeVerdict } from '../flowdoc/types';

// ── classification visuals (legend + node styling share this table) ──────────
// Classification visuals share the OBSERVED nodes' vocabulary: 2px status border,
// left accent strip, and 100-bg/700-text chips — so a node reads identically across
// Observed / Expected / Compare (the §2 "one canvas" rule). Expected mode is the
// neutral blueprint: gray border, no strip, no chip.
export const CLASSIFICATION_STYLE: Record<
  CompareClassification,
  { label: string; border: string; strip: string; chip: string; dot: string; dashed?: boolean; dim?: boolean }
> = {
  observed_success: { label: 'Observed · success', border: 'border-green-500', strip: 'bg-green-500', chip: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400', dot: 'bg-green-500' },
  observed_failed: { label: 'Observed · failed', border: 'border-red-500', strip: 'bg-red-500', chip: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400', dot: 'bg-red-500' },
  observed_running: { label: 'Observed · running', border: 'border-blue-500', strip: 'bg-blue-500', chip: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400', dot: 'bg-blue-500' },
  expected_missing: { label: 'Expected · missing', border: 'border-gray-300 border-dashed', strip: 'bg-gray-300', chip: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400', dot: 'bg-gray-400', dim: true },
  unexpected_observed: { label: 'Unexpected observed', border: 'border-amber-500', strip: 'bg-amber-500', chip: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400', dot: 'bg-amber-500' },
  condition_not_met: { label: 'Condition not met', border: 'border-gray-400 border-dashed', strip: 'bg-gray-400', chip: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400', dot: 'bg-gray-400', dim: true },
  optional_not_taken: { label: 'Optional not taken', border: 'border-gray-300 border-dotted', strip: 'bg-gray-300', chip: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400', dot: 'bg-gray-300', dim: true },
  retrying: { label: 'Retrying', border: 'border-blue-400', strip: 'bg-blue-400', chip: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400', dot: 'bg-blue-400' },
  timed_out: { label: 'Timed out', border: 'border-orange-500', strip: 'bg-orange-500', chip: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400', dot: 'bg-orange-500' },
  cancelled: { label: 'Cancelled', border: 'border-gray-500', strip: 'bg-gray-500', chip: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400', dot: 'bg-gray-500' },
  out_of_order: { label: 'Out of order', border: 'border-purple-400', strip: 'bg-purple-400', chip: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400', dot: 'bg-purple-400' },
  extra_invocation_chain: { label: 'Extra chain', border: 'border-amber-400', strip: 'bg-amber-400', chip: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400', dot: 'bg-amber-400' },
};

// Kind label colors mirror the Observed node components exactly (EventNode green,
// JobNode purple, InvocationNode blue) so the same entity reads the same in every mode.
const KIND_META: Record<string, { label: string; accent: string }> = {
  source: { label: 'Source', accent: 'text-blue-600 dark:text-blue-400' },
  event: { label: 'Event', accent: 'text-green-600 dark:text-green-400' },
  job: { label: 'Job', accent: 'text-purple-600 dark:text-purple-400' },
  sideEffect: { label: 'Side Effect', accent: 'text-teal-600 dark:text-teal-400' },
  terminal: { label: 'Terminal', accent: 'text-gray-600 dark:text-gray-300' },
};

interface ExpectedNodeData {
  graphNode: FlowGraphNode;
  verdict?: NodeVerdict; // absent in pure Expected mode
}

const ExpectedNode = memo(({ data }: NodeProps<ExpectedNodeData>) => {
  const { graphNode, verdict } = data;
  const kind = KIND_META[graphNode.kind] ?? KIND_META.event;
  const cls = verdict ? CLASSIFICATION_STYLE[verdict.classification] : undefined;

  return (
    <div
      className={`
        relative bg-white dark:bg-gray-800 rounded-lg border-2 shadow-md
        hover:shadow-lg transition-all duration-200
        ${cls ? cls.border : 'border-gray-300 dark:border-gray-600'}
        ${cls?.dim ? 'opacity-60' : ''}
        min-w-[220px] max-w-[260px]
      `}
    >
      <Handle type='target' position={Position.Left} className='w-3 h-3' />

      {/* Left accent strip — same affordance as the Observed nodes */}
      {cls && !cls.dim && <div className={`absolute left-0 top-0 bottom-0 w-1 ${cls.strip} rounded-l-lg`} />}

      <div className='p-3 pl-4'>
        <div className='flex items-center justify-between mb-1'>
          <span className={`text-xs font-semibold uppercase tracking-wide ${kind.accent}`}>{kind.label}</span>
          {verdict?.confidence === 'inferred' && (
            <span className='text-[9px] uppercase text-gray-400' title='verdict inferred, not directly recorded'>
              inferred
            </span>
          )}
        </div>

        <p className='font-medium text-gray-900 dark:text-white text-sm break-words'>{graphNode.label}</p>

        <div className='mt-1 flex items-center flex-wrap gap-1'>
          {cls && (
            <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls.chip}`} title={verdict?.detail}>
              {verdict?.detail ?? cls.label}
            </span>
          )}
          {!cls && graphNode.description && (
            <span className='text-xs text-gray-500 dark:text-gray-400 break-words'>{graphNode.description}</span>
          )}
          {graphNode.response && (
            <span className='inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'>
              responds: {graphNode.response}
            </span>
          )}
        </div>
      </div>

      <Handle type='source' position={Position.Right} className='w-3 h-3' />
    </div>
  );
});
ExpectedNode.displayName = 'ExpectedNode';

const nodeTypes = { expected: ExpectedNode };

// ── layered layout: source | events | jobs | sideEffects columns ─────────────
const COL_X: Record<string, number> = { source: 0, event: 340, job: 700, sideEffect: 1060, terminal: 1060 };
const ROW_H = 96;

function layout(nodes: FlowGraphNode[], verdicts?: Record<string, NodeVerdict>): Node<ExpectedNodeData>[] {
  const rows: Record<string, number> = {};
  return nodes.map(gn => {
    const col = gn.kind in COL_X ? gn.kind : 'event';
    const row = (rows[col] = (rows[col] ?? 0) + 1) - 1;
    return {
      id: gn.id,
      type: 'expected',
      position: { x: COL_X[col], y: row * ROW_H + (col === 'source' ? ROW_H : 0) },
      data: { graphNode: gn, verdict: verdicts?.[gn.id] },
    };
  });
}

export function CompareLegend({ summary }: { summary?: CompareResult['summary'] }) {
  const shown: CompareClassification[] = ['observed_success', 'observed_failed', 'observed_running', 'expected_missing', 'unexpected_observed'];
  return (
    <div className='bg-white/90 dark:bg-gray-800/90 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 shadow-sm space-y-1'>
      {summary && (
        <div className='text-[11px] text-gray-600 dark:text-gray-300 pb-1 border-b border-gray-100 dark:border-gray-700'>
          {summary.matched}/{summary.expectedTotal} matched · {summary.failed} failed · {summary.missing} missing ·{' '}
          {summary.unexpected} unexpected
        </div>
      )}
      {shown.map(c => (
        <div key={c} className='flex items-center gap-2 text-[11px] text-gray-600 dark:text-gray-300'>
          <span className={`w-2 h-2 rounded-full ${CLASSIFICATION_STYLE[c].dot}`} />
          {CLASSIFICATION_STYLE[c].label}
        </div>
      ))}
    </div>
  );
}

interface ExpectedFlowViewProps {
  doc: FlowDoc;
  compare?: CompareResult; // present = Compare mode
}

const ExpectedFlowViewInner: React.FC<ExpectedFlowViewProps> = ({ doc, compare }) => {
  const { nodes, edges } = useMemo(() => {
    const allGraphNodes = compare ? [...doc.graph.nodes, ...compare.extraNodes] : doc.graph.nodes;
    const allVerdicts = compare ? { ...compare.verdicts, ...compare.extraVerdicts } : undefined;
    const rfNodes = layout(allGraphNodes, allVerdicts);
    const allEdges = compare ? [...doc.graph.edges, ...compare.extraEdges] : doc.graph.edges;
    const rfEdges: Edge[] = allEdges.map(e => {
      const extra = compare?.extraVerdicts[e.to];
      const toV = compare ? (compare.verdicts[e.to] ?? extra) : undefined;
      const missing = toV?.classification === 'expected_missing';
      return {
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        animated: false,
        style: {
          strokeWidth: e.required ? 2.5 : 1.5,
          ...(missing ? { strokeDasharray: '6 4', opacity: 0.45 } : {}),
          ...(extra ? { stroke: '#f59e0b' } : {}),
        },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        ...(e.required ? { label: 'required', labelStyle: { fontSize: 9 } } : {}),
      };
    });
    return { nodes: rfNodes, edges: rfEdges };
  }, [doc, compare]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }}
      minZoom={0.1}
      maxZoom={2}
      nodesDraggable
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} className='bg-gray-50 dark:bg-gray-900' />
      <Controls className='bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700' />
      <MiniMap
        className='bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700'
        nodeColor={n => {
          const v = (n.data as ExpectedNodeData | undefined)?.verdict;
          if (!v) return '#9ca3af';
          const c = v.classification;
          if (c === 'observed_success') return '#22c55e';
          if (c === 'observed_failed') return '#ef4444';
          if (c === 'unexpected_observed') return '#f59e0b';
          if (c === 'observed_running') return '#3b82f6';
          return '#d1d5db';
        }}
      />
    </ReactFlow>
  );
};

const ExpectedFlowView: React.FC<ExpectedFlowViewProps> = props => (
  <ReactFlowProvider>
    <ExpectedFlowViewInner {...props} />
  </ReactFlowProvider>
);

export default ExpectedFlowView;
