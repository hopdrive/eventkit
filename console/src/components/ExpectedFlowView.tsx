// Expected + Compare rendering for the flow canvas.
//
// Expected mode draws the committed flow doc's structure (source -> events ->
// jobs -> sideEffects) as the canonical shape of the process. Compare mode colors
// each node by the matcher's classification (§3) and grafts unexpected observed
// activity into the same canvas. One layered layout for both.

import React, { memo, useMemo } from 'react';
import ReactFlow, { Background, Controls, Handle, MarkerType, MiniMap, Position, ReactFlowProvider } from 'reactflow';
import type { Edge, Node, NodeProps } from 'reactflow';
import {
  BoltIcon,
  CircleStackIcon,
  WrenchScrewdriverIcon,
  ArrowTopRightOnSquareIcon,
} from '@heroicons/react/24/outline';
import type { CompareClassification, CompareResult, FlowDoc, FlowGraphNode, NodeVerdict } from '../flowdoc/types';

// ── classification visuals (legend + node styling share this table) ──────────
export const CLASSIFICATION_STYLE: Record<
  CompareClassification,
  { label: string; border: string; bg: string; dot: string }
> = {
  observed_success: { label: 'Observed · success', border: 'border-green-500', bg: 'bg-green-50 dark:bg-green-900/20', dot: 'bg-green-500' },
  observed_failed: { label: 'Observed · failed', border: 'border-red-500', bg: 'bg-red-50 dark:bg-red-900/20', dot: 'bg-red-500' },
  observed_running: { label: 'Observed · running', border: 'border-blue-500', bg: 'bg-blue-50 dark:bg-blue-900/20', dot: 'bg-blue-500' },
  expected_missing: { label: 'Expected · missing', border: 'border-gray-300 border-dashed', bg: 'bg-gray-50 dark:bg-gray-800/60', dot: 'bg-gray-400' },
  unexpected_observed: { label: 'Unexpected observed', border: 'border-amber-500', bg: 'bg-amber-50 dark:bg-amber-900/20', dot: 'bg-amber-500' },
  condition_not_met: { label: 'Condition not met', border: 'border-gray-400 border-dashed', bg: 'bg-gray-50 dark:bg-gray-800/60', dot: 'bg-gray-400' },
  optional_not_taken: { label: 'Optional not taken', border: 'border-gray-300 border-dotted', bg: 'bg-gray-50 dark:bg-gray-800/60', dot: 'bg-gray-300' },
  retrying: { label: 'Retrying', border: 'border-blue-400', bg: 'bg-blue-50 dark:bg-blue-900/20', dot: 'bg-blue-400' },
  timed_out: { label: 'Timed out', border: 'border-orange-500', bg: 'bg-orange-50 dark:bg-orange-900/20', dot: 'bg-orange-500' },
  cancelled: { label: 'Cancelled', border: 'border-gray-500', bg: 'bg-gray-100 dark:bg-gray-800', dot: 'bg-gray-500' },
  out_of_order: { label: 'Out of order', border: 'border-purple-400', bg: 'bg-purple-50 dark:bg-purple-900/20', dot: 'bg-purple-400' },
  extra_invocation_chain: { label: 'Extra chain', border: 'border-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/10', dot: 'bg-amber-400' },
};

const KIND_META: Record<string, { label: string; icon: typeof BoltIcon; accent: string }> = {
  source: { label: 'SOURCE', icon: CircleStackIcon, accent: 'text-gray-600 dark:text-gray-300' },
  event: { label: 'EVENT', icon: BoltIcon, accent: 'text-green-700 dark:text-green-400' },
  job: { label: 'JOB', icon: WrenchScrewdriverIcon, accent: 'text-purple-700 dark:text-purple-400' },
  sideEffect: { label: 'SIDE EFFECT', icon: ArrowTopRightOnSquareIcon, accent: 'text-blue-700 dark:text-blue-400' },
  terminal: { label: 'TERMINAL', icon: CircleStackIcon, accent: 'text-gray-600 dark:text-gray-300' },
};

interface ExpectedNodeData {
  graphNode: FlowGraphNode;
  verdict?: NodeVerdict; // absent in pure Expected mode
}

const ExpectedNode = memo(({ data }: NodeProps<ExpectedNodeData>) => {
  const { graphNode, verdict } = data;
  const kind = KIND_META[graphNode.kind] ?? KIND_META.event;
  const Icon = kind.icon;
  const cls = verdict ? CLASSIFICATION_STYLE[verdict.classification] : undefined;

  return (
    <div
      className={`rounded-lg border-2 px-3 py-2 shadow-sm min-w-[190px] max-w-[240px] ${
        cls ? `${cls.border} ${cls.bg}` : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800'
      }`}
    >
      <Handle type='target' position={Position.Left} className='!bg-gray-400 !w-2 !h-2' />
      <div className='flex items-center justify-between gap-2'>
        <span className={`flex items-center gap-1 text-[10px] font-semibold tracking-wider ${kind.accent}`}>
          <Icon className='h-3 w-3' />
          {kind.label}
        </span>
        {verdict && (
          <span className='flex items-center gap-1'>
            {verdict.confidence === 'inferred' && (
              <span className='text-[9px] uppercase text-gray-400' title='verdict inferred, not directly recorded'>
                inferred
              </span>
            )}
            <span className={`w-2 h-2 rounded-full ${cls!.dot}`} title={cls!.label} />
          </span>
        )}
      </div>
      <div className='mt-1 text-sm font-mono font-medium text-gray-900 dark:text-gray-100 break-words'>
        {graphNode.label}
      </div>
      {(verdict?.detail || graphNode.description) && (
        <div className='mt-0.5 text-[11px] text-gray-500 dark:text-gray-400 break-words'>
          {verdict?.detail ?? graphNode.description}
        </div>
      )}
      {graphNode.response && (
        <div className='mt-0.5 text-[10px] text-blue-600 dark:text-blue-400'>responds: {graphNode.response}</div>
      )}
      <Handle type='source' position={Position.Right} className='!bg-gray-400 !w-2 !h-2' />
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
