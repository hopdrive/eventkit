import React, { useCallback, useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { nodeTypes } from './nodes';
import { useFlowPositioning } from '../hooks/useFlowPositioning';
import ReactFlow, {
  Node,
  Edge,
  Controls,
  Background,
  MiniMap,
  MarkerType,
  useReactFlow,
  NodeProps,
  ReactFlowProvider,
  ConnectionMode,
} from 'reactflow';
import { AnimatePresence } from 'framer-motion';
import { useInvocationTreeFlowQuery } from '../types/generated';
import InvocationDetailDrawer from './InvocationDetailDrawer';
import 'reactflow/dist/style.css';
import JobDetailDrawer from './JobDetailDrawer';
import EventDetailDrawer from './EventDetailDrawer';
import UndetectedEventsDetailDrawer from './UndetectedEventsDetailDrawer';
import { compareFlow } from '../flowdoc/compare';
import { loadBundledDocs, loadUploadedDocs, saveUploadedDoc } from '../flowdoc/store';
import type { FlowDoc } from '../flowdoc/types';

// ONE canvas, overlay toggles (not separate views): the observed run always renders
// with its normal nodes; toggles only ADD or REMOVE nodes and never change the size
// or content of anything already on the canvas. "Show expected" grafts the flow
// doc's not-observed events/jobs in as same-size ghost nodes (rendered by the SAME
// EventNode/JobNode components); "Flag off-contract" rings observed nodes absent
// from the doc (outline only).

// Inner component that uses ReactFlow hooks
const FlowDiagramContent = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const reactFlowInstance = useReactFlow();

  // Remove useNodesState and useEdgesState to avoid conflicts
  // We'll use direct props instead
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [autoFocusCompleted, setAutoFocusCompleted] = useState(false);
  const [docs, setDocs] = useState<FlowDoc[]>([]);
  const [selectedDocTitle, setSelectedDocTitle] = useState<string>('');
  const [docError, setDocError] = useState<string>('');

  // URL Parameters
  const invocationId = searchParams.get('invocationId');
  const autoFocus = searchParams.get('autoFocus') === 'true';
  const showExpected = searchParams.get('expected') === '1';
  const flagOffContract = searchParams.get('offcontract') === '1';

  const setFlag = (key: string, on: boolean) => {
    const next = new URLSearchParams(searchParams);
    if (on) next.set(key, '1');
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  // Flow-doc library: bundled samples + uploads (persisted).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const bundled = await loadBundledDocs();
      if (!cancelled) {
        setDocs(d => {
          const merged = [...loadUploadedDocs(), ...bundled];
          setSelectedDocTitle(t => t || merged[0]?.title || '');
          return merged.length ? merged : d;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedDoc = docs.find(d => d.title === selectedDocTitle);

  const handleUpload = async (file: File) => {
    try {
      const doc = saveUploadedDoc(await file.text());
      setDocs(d => [doc, ...d.filter(x => x.title !== doc.title)]);
      setSelectedDocTitle(doc.title);
      setDocError('');
    } catch (e) {
      setDocError((e as Error).message);
    }
  };

  // GraphQL Query for invocation tree flow
  const { data, loading, error } = useInvocationTreeFlowQuery({
    variables: { invocationId: invocationId || '' },
    skip: !invocationId,
    fetchPolicy: 'cache-first',
    errorPolicy: 'all',
  });

  // Use the positioning hook to generate nodes and edges
  // Combine the main invocation with its correlated invocations for recursive rendering
  const invocations = data?.invocations_by_pk
    ? [data.invocations_by_pk, ...(data.invocations_by_pk.correlated_invocations || [])]
    : [];
  const { nodes: generatedNodes, edges: generatedEdges } = useFlowPositioning(invocations);

  // Compare: overlay this run's observed tree on the selected expected graph.
  const compareResult = useMemo(() => {
    if ((!showExpected && !flagOffContract) || !selectedDoc || invocations.length === 0) return undefined;
    return compareFlow(selectedDoc.graph, invocations as Parameters<typeof compareFlow>[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showExpected, flagOffContract, selectedDoc, data]);


  // Auto-focus functionality
  useEffect(() => {
    if (autoFocus && invocationId && reactFlowInstance && generatedNodes.length > 0 && !autoFocusCompleted) {
      const targetNode = generatedNodes.find(node => node.id === invocationId);
      if (targetNode) {
        // Fit the whole chain instead of setCenter on one node: the immediate
        // setCenter ran before ReactFlow had measured the nodes and left the viewport
        // on a blank region until a manual fit-view (bug found in C1 verification).
        // Deferring one frame lets ReactFlow initialize; fitView is the same
        // known-good path as the manual control.
        requestAnimationFrame(() => {
          reactFlowInstance.fitView({ padding: 0.2, maxZoom: 1.2, minZoom: 0.1, duration: 300 });
        });

        // Mark auto-focus as completed to prevent repeated execution
        setAutoFocusCompleted(true);

        // Remove autoFocus parameter from URL after focusing
        const newSearchParams = new URLSearchParams(searchParams);
        newSearchParams.delete('autoFocus');
        navigate(
          {
            pathname: location.pathname,
            search: newSearchParams.toString(),
          },
          { replace: true }
        );
      }
    }
  }, [
    autoFocus,
    invocationId,
    reactFlowInstance,
    generatedNodes,
    autoFocusCompleted,
    searchParams,
    navigate,
    location.pathname,
  ]);

  // No longer need to set nodes/edges state since we're using direct props

  // Auto-fit view to show all nodes
  useEffect(() => {
    if (generatedNodes.length > 0 && reactFlowInstance) {
      // Auto-fit view to show all nodes with proper padding
      setTimeout(() => {
        reactFlowInstance.fitView({
          padding: 0.2,
          includeHiddenNodes: false,
          maxZoom: 1.5,
          minZoom: 0.1,
        });
      }, 100);
    }
  }, [generatedNodes.length, reactFlowInstance]);

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
    setDrawerOpen(true);

    // Center and zoom on the selected node, accounting for the 600px drawer on the right
    setTimeout(() => {
      if (reactFlowInstance) {
        const flowBounds = document.querySelector('.react-flow')?.getBoundingClientRect();

        if (flowBounds) {
          const drawerWidth = 600;
          const zoom = 1.5;
          const totalWidth = flowBounds.width;
          const visibleWidth = totalWidth - drawerWidth;

          // FLIPPED: To shift the viewport so the node appears LEFT (in visible area),
          // we actually need to move the CENTER POINT to the RIGHT in flow coordinates
          // This is because setCenter positions what FLOW POINT appears at screen center

          // We want the node to appear at the center of the visible area
          // which is visibleWidth/2 from the left edge of the screen
          // In terms of offset from total screen center: -(drawerWidth/2)
          // But since we're moving the flow coordinate that appears at screen center,
          // we need to ADD (positive) to shift viewport left
          const shiftRight = (drawerWidth / 2);

          // Convert to flow coordinates
          const centerShiftInFlowCoords = shiftRight / zoom;

          // Position the node in the center of the visible area
          reactFlowInstance.setCenter(
            node.position.x + 120 + centerShiftInFlowCoords,
            node.position.y,
            {
              zoom: zoom,
              duration: 800
            }
          );
        }
      }
    }, 100);
  }, [reactFlowInstance]);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setDrawerOpen(false);

    // Zoom out to show the entire flow diagram
    if (reactFlowInstance) {
      reactFlowInstance.fitView({
        padding: 0.2,
        duration: 800,
        maxZoom: 1.5,
        minZoom: 0.1
      });
    }
  }, [reactFlowInstance]);

  // Node dragging will work automatically with direct props

  // Filter nodes based on search - memoized to prevent re-renders
  const flowData = useMemo(() => {
    const filteredNodes = generatedNodes.filter((node) => {
      if (!searchTerm) return true;
      const searchLower = searchTerm.toLowerCase();

      // Search in node data based on node type
      switch (node.type) {
        case 'invocation':
          return (
            node.data.sourceFunction?.toLowerCase().includes(searchLower) ||
            node.data.correlationId?.toLowerCase().includes(searchLower)
          );
        case 'event':
          return (
            node.data.eventName?.toLowerCase().includes(searchLower) ||
            node.data.correlationId?.toLowerCase().includes(searchLower)
          );
        case 'job':
          return (
            node.data.jobName?.toLowerCase().includes(searchLower) ||
            node.data.functionName?.toLowerCase().includes(searchLower) ||
            node.data.correlationId?.toLowerCase().includes(searchLower)
          );
        case 'groupedEvents':
          return node.data.events?.some((event: any) =>
            event.event_name?.toLowerCase().includes(searchLower)
          );
        default:
          return true;
      }
    });

    // Mark the selected node
    const nodesWithSelection = filteredNodes.map(node => ({
      ...node,
      selected: selectedNode?.id === node.id
    }));

    // Filter edges to only include those connecting visible nodes
    const filteredNodeIds = new Set(filteredNodes.map(node => node.id));
    const filteredEdges = generatedEdges.filter(edge =>
      filteredNodeIds.has(edge.source) && filteredNodeIds.has(edge.target)
    );

    return { nodes: nodesWithSelection, edges: filteredEdges };
  }, [generatedNodes, generatedEdges, searchTerm, selectedNode]);

  // Merge overlay additions into the observed canvas. Ghost nodes reuse the SAME
  // EventNode/JobNode components (identical shell/size); toggles only add/remove
  // nodes — they never restyle what's already rendered. Off-contract flagging adds
  // an outline ring only (no size/content change).
  const displayData = useMemo(() => {
    let nodes = flowData.nodes;
    let edges = flowData.edges;
    if (!compareResult) return { nodes, edges };

    if (flagOffContract) {
      const extraEventNames = new Set<string>();
      const extraJobNames = new Set<string>();
      for (const key of Object.keys(compareResult.extraVerdicts)) {
        if (key.startsWith('event:')) extraEventNames.add(key.slice(6));
        else if (key.startsWith('job:')) extraJobNames.add(key.split(':')[2]);
      }
      nodes = nodes.map(n =>
        (n.type === 'event' && extraEventNames.has(n.data?.eventName)) ||
        (n.type === 'job' && extraJobNames.has(n.data?.jobName))
          ? { ...n, className: `${n.className ?? ''} rounded-lg ring-4 ring-amber-400/70` }
          : n
      );
    }

    if (showExpected && selectedDoc) {
      // Ghost columns join the observed layout: reuse the observed x positions.
      const colX = (t: string, fallback: number) => {
        const of = nodes.filter(n => n.type === t);
        return of.length ? Math.max(...of.map(n => n.position.x)) : fallback;
      };
      const root = nodes.find(n => n.type === 'invocation');
      const rootX = root?.position.x ?? 0;
      const eventX = colX('event', rootX + 530);
      const jobX = colX('job', rootX + 960);
      let y = Math.max(0, ...nodes.map(n => n.position.y)) + 180;
      const rootId = root?.id ?? invocationId ?? '';

      const missing = (id: string) => compareResult.verdicts[id]?.classification === 'expected_missing';
      const ghostEdgeStyle = { strokeDasharray: '6 4', stroke: '#9ca3af', strokeWidth: 1.5 };
      for (const gn of selectedDoc.graph.nodes) {
        if (gn.kind !== 'event' || !missing(gn.id)) continue;
        nodes = [...nodes, {
          id: `ghost-${gn.id}`,
          type: 'event',
          selected: false,
          position: { x: eventX, y },
          data: { eventName: gn.eventName ?? gn.label, ghost: true, detected: false, correlationId: '', status: '', detectionDuration: 0, jobsCount: 0, hasFailedJobs: false },
        }];
        edges = [...edges, { id: `ghost-e-${gn.id}`, source: rootId, target: `ghost-${gn.id}`, animated: false, style: ghostEdgeStyle }];
        let jy = y;
        for (const je of selectedDoc.graph.edges.filter(e => e.from === gn.id)) {
          const jn = selectedDoc.graph.nodes.find(n => n.id === je.to && n.kind === 'job');
          if (!jn || !missing(jn.id)) continue;
          nodes = [...nodes, {
            id: `ghost-${jn.id}`,
            type: 'job',
            selected: false,
            position: { x: jobX, y: jy },
            data: { jobName: jn.jobName ?? jn.label, ghost: true, correlationId: '', status: '', duration: 0 },
          }];
          edges = [...edges, { id: `ghost-e-${jn.id}`, source: `ghost-${gn.id}`, target: `ghost-${jn.id}`, animated: false, style: ghostEdgeStyle }];
          jy += 110;
        }
        y = Math.max(y + 140, jy + 30);
      }
    }
    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowData, compareResult, showExpected, flagOffContract, selectedDoc, invocationId]);



  const observedGate = loading ? (
    <div className='flex items-center justify-center h-full'>
      <div className='animate-spin rounded-full h-32 w-32 border-b-2 border-blue-500'></div>
    </div>
  ) : error ? (
    <div className='flex items-center justify-center h-full'>
      <div className='text-red-500'>Error loading flow diagram: {error.message}</div>
    </div>
  ) : !data?.invocations_by_pk ? (
    <div className='flex items-center justify-center h-full'>
      <div className='text-gray-500'>No invocation data found</div>
    </div>
  ) : null;

  return (
    <div className="w-full h-full relative" style={{ minHeight: '600px' }}>
      {/* Toolbar: search + expected-overlay toggles (one canvas — toggles only add/remove nodes) */}
      <div className='absolute top-4 left-4 z-10 flex items-center gap-2 flex-wrap'>
        <input
          type='text'
          placeholder='Search nodes...'
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className='px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm w-56'
        />
        <label className='inline-flex items-center gap-1.5 px-2.5 py-2 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700'>
          <input
            type='checkbox'
            checked={showExpected}
            onChange={e => setFlag('expected', e.target.checked)}
            className='h-3.5 w-3.5 text-blue-600 border-gray-300 rounded'
          />
          Show expected
        </label>
        <label className='inline-flex items-center gap-1.5 px-2.5 py-2 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700'>
          <input
            type='checkbox'
            checked={flagOffContract}
            onChange={e => setFlag('offcontract', e.target.checked)}
            className='h-3.5 w-3.5 text-amber-500 border-gray-300 rounded'
          />
          Flag off-contract
        </label>
        {(showExpected || flagOffContract) && (
          <>
            <select
              value={selectedDocTitle}
              onChange={e => setSelectedDocTitle(e.target.value)}
              className='px-2 py-2 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 max-w-[220px]'
            >
              {docs.length === 0 && <option value=''>no flow docs loaded</option>}
              {docs.map(d => (
                <option key={d.title} value={d.title}>
                  {d.title}
                  {d.origin === 'uploaded' ? ' (uploaded)' : ''}
                </option>
              ))}
            </select>
            <label className='px-2 py-2 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700'>
              Load flow doc…
              <input
                type='file'
                accept='.yaml,.yml,.json'
                className='hidden'
                onChange={e => e.target.files?.[0] && handleUpload(e.target.files[0])}
              />
            </label>
            {docError && (
              <span className='text-xs text-red-500 max-w-[280px] truncate' title={docError}>
                {docError}
              </span>
            )}
          </>
        )}
      </div>

      {/* Overlay legend + summary (only when a toggle is active) */}
      {compareResult && (showExpected || flagOffContract) && (
        <div className='absolute top-4 right-4 z-10 bg-white/90 dark:bg-gray-800/90 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 shadow-sm space-y-1'>
          <div className='text-[11px] text-gray-600 dark:text-gray-300 pb-1 border-b border-gray-100 dark:border-gray-700'>
            {compareResult.summary.matched}/{compareResult.summary.expectedTotal} matched ·{' '}
            {compareResult.summary.failed} failed · {compareResult.summary.missing} missing ·{' '}
            {compareResult.summary.unexpected} off-contract
          </div>
          {showExpected && (
            <div className='flex items-center gap-2 text-[11px] text-gray-600 dark:text-gray-300'>
              <span className='w-3 h-3 rounded border-2 border-dashed border-gray-400' /> expected · not observed
            </div>
          )}
          {flagOffContract && (
            <div className='flex items-center gap-2 text-[11px] text-gray-600 dark:text-gray-300'>
              <span className='w-3 h-3 rounded ring-2 ring-amber-400/80' /> observed · not in flow doc
            </div>
          )}
        </div>
      )}

      {observedGate ?? (
      <ReactFlow
        nodes={displayData.nodes}
        edges={displayData.edges}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        connectionMode={ConnectionMode.Loose}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        minZoom={0.1}
        maxZoom={2}
        attributionPosition="bottom-left"
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={true}
        defaultEdgeOptions={{
          type: 'default', // Use bezier curves for smooth connections
          animated: false, // perf fix P6: per-edge marching-ants animation janks large chains
          style: { strokeWidth: 2 },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 20,
            height: 20,
          },
        }}
      >
        <Background gap={20} className='bg-gray-50 dark:bg-gray-900' />
        <Controls className='bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700' />
        <MiniMap
          className='bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700'
          nodeColor={node => {
            if (node.type === 'invocation') return '#3b82f6';
            if (node.type === 'event') return '#10b981';
            if (node.type === 'job') return '#8b5cf6';
            return '#6b7280';
          }}
        />
      </ReactFlow>
      )}

      {/* Detail Drawer - Type-specific modals */}
      <AnimatePresence>
        {drawerOpen && selectedNode && (
          <>
            {selectedNode.type === 'invocation' && (
              <InvocationDetailDrawer node={selectedNode} isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} />
            )}
            {selectedNode.type === 'job' && (
              <JobDetailDrawer node={selectedNode} isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} />
            )}
            {selectedNode.type === 'event' && (
              <EventDetailDrawer node={selectedNode} isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} />
            )}
            {selectedNode.type === 'groupedEvents' && (
              <UndetectedEventsDetailDrawer node={selectedNode} isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} />
            )}
          </>
        )}
      </AnimatePresence>
    </div>
  );
};

// Main component that provides ReactFlow context
const FlowDiagram = () => {
  return (
    <ReactFlowProvider>
      <FlowDiagramContent />
    </ReactFlowProvider>
  );
};

export default FlowDiagram;