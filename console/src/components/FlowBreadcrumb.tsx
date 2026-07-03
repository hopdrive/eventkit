// Breadcrumb trail along the BOTTOM edge of the flow canvas: the graph path from
// the chain's origin to the currently selected node (origin invocation → event →
// job → chained invocation → …). It recomputes from the edge graph on every
// selection change — canvas click, drawer child-row jump, or back button — so it
// always answers "where am I and how did the system get here". Crumbs are
// clickable: selecting one swaps the drawer and pans the canvas to that node.

import React, { useMemo } from 'react';
import { Node, Edge } from 'reactflow';
import { ChevronRightIcon } from '@heroicons/react/24/outline';

const KIND_STYLES: Record<string, { label: string; chip: string; active: string }> = {
  invocation: {
    label: 'text-blue-600 dark:text-blue-400',
    chip: 'hover:bg-blue-50 dark:hover:bg-blue-900/30',
    active: 'bg-blue-600 text-white',
  },
  event: {
    label: 'text-green-600 dark:text-green-400',
    chip: 'hover:bg-green-50 dark:hover:bg-green-900/30',
    active: 'bg-green-600 text-white',
  },
  job: {
    label: 'text-purple-600 dark:text-purple-400',
    chip: 'hover:bg-purple-50 dark:hover:bg-purple-900/30',
    active: 'bg-purple-600 text-white',
  },
};

const nodeLabel = (n: Node): string =>
  n.data?.sourceFunction ?? n.data?.eventName ?? n.data?.jobName ?? n.data?.label ?? n.id;

/** Walk incoming edges from `nodeId` up to the root. Each node in this layout has
 *  at most one structural parent (job→invocation, invocation→event, event→job);
 *  if overlays add a second incoming edge, the first non-ghost edge wins. */
function pathToRoot(nodeId: string, nodes: Node[], edges: Edge[]): Node[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const parentOf = new Map<string, string>();
  const structural = edges.filter(e => !String(e.id).startsWith('ghost-'));
  const ghost = edges.filter(e => String(e.id).startsWith('ghost-'));
  for (const e of [...structural, ...ghost]) {
    if (!parentOf.has(e.target)) parentOf.set(e.target, e.source);
  }
  const path: Node[] = [];
  let cur: string | undefined = nodeId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n = byId.get(cur);
    if (n) path.unshift(n);
    cur = parentOf.get(cur);
  }
  return path;
}

interface FlowBreadcrumbProps {
  selectedNode: Node | null;
  nodes: Node[];
  edges: Edge[];
  onSelect: (nodeId: string) => void;
  /** Raise above the replay transport bar when playback mode is active. */
  lifted?: boolean;
  /** Center within the visible canvas when the 600px detail drawer is open —
   *  keyboard selection shows the trail without opening the drawer. */
  drawerOpen?: boolean;
}

const FlowBreadcrumb: React.FC<FlowBreadcrumbProps> = ({ selectedNode, nodes, edges, onSelect, lifted, drawerOpen }) => {
  const path = useMemo(
    () => (selectedNode ? pathToRoot(selectedNode.id, nodes, edges) : []),
    [selectedNode, nodes, edges]
  );
  if (!selectedNode || path.length === 0) return null;

  return (
    // Centered within the VISIBLE canvas (offset left of the drawer when open).
    <div
      className={`absolute ${lifted ? 'bottom-20' : 'bottom-3'} -translate-x-1/2 z-40 min-w-0 ${
        drawerOpen ? 'left-[calc((100%-600px)/2)] max-w-[calc(100%-640px)]' : 'left-1/2 max-w-[calc(100%-32px)]'
      }`}
    >
      <div className='flex items-center gap-0.5 px-2 py-1.5 rounded-lg bg-white/95 dark:bg-gray-800/95 border border-gray-200 dark:border-gray-700 shadow-lg backdrop-blur overflow-x-auto whitespace-nowrap'>
        {path.map((n, i) => {
          const kind = KIND_STYLES[n.type ?? ''] ?? KIND_STYLES.invocation;
          const isCurrent = n.id === selectedNode.id;
          const isOrigin = n.type === 'invocation' && n.data?.isOrigin;
          return (
            <React.Fragment key={n.id}>
              {i > 0 && <ChevronRightIcon className='h-3 w-3 text-gray-300 dark:text-gray-600 flex-shrink-0' />}
              <button
                onClick={() => !isCurrent && onSelect(n.id)}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium transition-colors flex-shrink-0 ${
                  isCurrent ? kind.active : `${kind.chip} ${kind.label}`
                } ${isCurrent ? 'cursor-default' : 'cursor-pointer'}`}
                title={`${n.type}: ${nodeLabel(n)}`}
              >
                {isOrigin && (
                  <span
                    className={`px-1 py-px rounded text-[9px] font-bold tracking-wider ${
                      isCurrent ? 'bg-white/25 text-white' : 'bg-blue-600 text-white'
                    }`}
                  >
                    ORIGIN
                  </span>
                )}
                <span className='max-w-[180px] truncate'>{nodeLabel(n)}</span>
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

export default FlowBreadcrumb;
