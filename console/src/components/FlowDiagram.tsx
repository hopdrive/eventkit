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
import FlowBreadcrumb from './FlowBreadcrumb';
import FlowStatsPill from './FlowStatsPill';
import FlowPlaybackBar from './FlowPlaybackBar';
import KeyboardShortcutsOverlay from './KeyboardShortcutsOverlay';
import { useFlowPlayback, SPEED_PRESETS } from '../hooks/useFlowPlayback';
import { useFlowHotkeys } from '../hooks/useFlowHotkeys';
import { PlayIcon } from '@heroicons/react/20/solid';
import { compareFlow } from '../flowdoc/compare';
import { loadBundledDocs, loadUploadedDocs, saveUploadedDoc } from '../flowdoc/store';
import type { FlowDoc } from '../flowdoc/types';

// ONE canvas, overlay toggles (not separate views): the observed run always renders
// with its normal nodes; toggles only ADD or REMOVE nodes and never change the size
// or content of anything already on the canvas. "Show expected" grafts the flow
// doc's not-observed events/jobs in as same-size ghost nodes (rendered by the SAME
// EventNode/JobNode components); "Flag off-contract" rings observed nodes absent
// from the doc (outline only).

// Referentially-stable ReactFlow props: inline literals here would hand ReactFlow
// a "changed" prop on every render and make it churn its internal edge/node state.
const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };
const DEFAULT_EDGE_OPTIONS = {
  type: 'default', // bezier curves for smooth connections
  animated: false, // perf fix P6: per-edge marching-ants animation janks large chains
  style: { strokeWidth: 2 },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    width: 20,
    height: 20,
  },
};
const minimapNodeColor = (node: Node) => {
  if (node.type === 'invocation') return '#3b82f6';
  if (node.type === 'event') return '#10b981';
  if (node.type === 'job') return '#8b5cf6';
  return '#6b7280';
};

// Inner component that uses ReactFlow hooks
const FlowDiagramContent = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const reactFlowInstance = useReactFlow();

  // Remove useNodesState and useEdgesState to avoid conflicts
  // We'll use direct props instead
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Trail of previously-viewed nodes for the drawer's back button; cross-navigation
  // pushes, back pops, a fresh canvas click or drawer close resets.
  const [drawerHistory, setDrawerHistory] = useState<Node[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [autoFocusCompleted, setAutoFocusCompleted] = useState(false);
  const [docs, setDocs] = useState<FlowDoc[]>([]);
  const [selectedDocTitle, setSelectedDocTitle] = useState<string>('');
  const [docError, setDocError] = useState<string>('');
  const [helpOpen, setHelpOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // URL Parameters
  const invocationId = searchParams.get('invocationId');
  const autoFocus = searchParams.get('autoFocus') === 'true';
  const showExpected = searchParams.get('expected') === '1';
  const flagOffContract = searchParams.get('offcontract') === '1';
  const showUndetected = searchParams.get('undetected') === '1';

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
  // Combine the main invocation with its correlated invocations for recursive rendering.
  // MUST be memoized: a fresh array every render would invalidate the layout memo and
  // rebuild every node/edge object on every render of this component.
  const invocations = useMemo(
    () =>
      data?.invocations_by_pk
        ? [data.invocations_by_pk, ...(data.invocations_by_pk.correlated_invocations || [])]
        : [],
    [data]
  );
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

  // Center and zoom on a node, optionally shifted so it lands in the middle of the
  // visible area LEFT of the 600px drawer (setCenter positions a FLOW POINT at the
  // screen center, so the center point moves RIGHT by half the drawer width in flow
  // coordinates). Clicks zoom in to 1.5; keyboard walking keeps the user's zoom
  // (clamped) so arrow-stepping through the chain doesn't lurch the viewport.
  const centerOnNode = useCallback(
    (node: Node, opts?: { drawer?: boolean; keepZoom?: boolean }) => {
      if (!reactFlowInstance) return;
      const drawer = opts?.drawer ?? true;
      const zoom = opts?.keepZoom ? Math.min(Math.max(reactFlowInstance.getZoom(), 0.75), 1.5) : 1.5;
      const shift = drawer ? 600 / 2 / zoom : 0;
      reactFlowInstance.setCenter(
        node.position.x + (node.width ?? 240) / 2 + shift,
        node.position.y + (node.height ?? 70) / 2,
        { zoom, duration: 500 }
      );
    },
    [reactFlowInstance]
  );

  const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node);
    setDrawerOpen(true);
    setDrawerHistory([]); // direct canvas click starts a fresh navigation trail
    centerOnNode(node);
  }, [centerOnNode]);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    setDrawerOpen(false);
    setDrawerHistory([]);

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
    // Chain orientation: mark the ORIGIN (no source_job_id — the invocation that
    // caused everything downstream) and the entered/"viewing" invocation, so a user
    // landing mid-chain can orient instantly. Always on — not a toggle.
    const originIds = new Set(invocations.filter(i => !i.source_job_id).map(i => i.id));
    let nodes = flowData.nodes.map(n =>
      n.type === 'invocation'
        ? { ...n, data: { ...n.data, isOrigin: originIds.has(n.id), isFocus: n.id === invocationId } }
        : n
    );
    let edges = flowData.edges;
    if (!compareResult && !showUndetected) return { nodes, edges };

    if (flagOffContract && compareResult) {
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

    if (showExpected || showUndetected) {
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
      const ghostEdgeStyle = { strokeDasharray: '6 4', stroke: '#9ca3af', strokeWidth: 1.5 };

      // One node per event name, deduped across the two sources of "didn't happen":
      //   ran · not detected      — a detector evaluated false this run (observed record)
      //   expected · not observed — in the flow doc but no detector even ran (drift)
      const ghosts = new Map<string, { label: string; docId?: string; warn?: boolean }>();
      if (showUndetected) {
        for (const inv of invocations) {
          for (const ev of inv.event_executions ?? []) {
            if (!ev.detected && !ghosts.has(ev.event_name)) {
              ghosts.set(ev.event_name, { label: 'ran · not detected' });
            }
          }
        }
      }
      if (showExpected && selectedDoc && compareResult) {
        for (const gn of selectedDoc.graph.nodes) {
          if (gn.kind !== 'event') continue;
          const name = gn.eventName ?? gn.label;
          const existing = ghosts.get(name);
          if (existing) {
            existing.docId = gn.id; // deduped: keep the stronger ran·not-detected label
          } else if (compareResult.verdicts[gn.id]?.classification === 'expected_missing') {
            // Drift warning: every registered detector evaluates on every invocation,
            // so a doc event with NO record means doc/code version skew, the wrong
            // doc for this function, or a lost observability write — all defects.
            ghosts.set(name, { label: 'never ran — doc/code drift?', docId: gn.id, warn: true });
          }
        }
      }

      const missing = (id: string) => compareResult?.verdicts[id]?.classification === 'expected_missing';
      for (const [name, g] of ghosts) {
        const evNodeId = `ghost-event:${name}`;
        nodes = [...nodes, {
          id: evNodeId,
          type: 'event',
          selected: false,
          position: { x: eventX, y },
          data: { eventName: name, ghost: true, ghostLabel: g.label, ghostTone: g.warn ? 'warning' : 'neutral', detected: false, correlationId: '', status: '', detectionDuration: 0, jobsCount: 0, hasFailedJobs: false },
        }];
        edges = [...edges, { id: `ghost-e-${name}`, source: rootId, target: evNodeId, animated: false, style: ghostEdgeStyle }];
        let jy = y;
        if (g.docId && selectedDoc && showExpected) {
          for (const je of selectedDoc.graph.edges.filter(e => e.from === g.docId)) {
            const jn = selectedDoc.graph.nodes.find(n => n.id === je.to && n.kind === 'job');
            if (!jn || !missing(jn.id)) continue;
            nodes = [...nodes, {
              id: `ghost-${jn.id}`,
              type: 'job',
              selected: false,
              position: { x: jobX, y: jy },
              data: { jobName: jn.jobName ?? jn.label, ghost: true, correlationId: '', status: '', duration: 0 },
            }];
            edges = [...edges, { id: `ghost-e-${jn.id}`, source: evNodeId, target: `ghost-${jn.id}`, animated: false, style: ghostEdgeStyle }];
            jy += 110;
          }
        }
        y = Math.max(y + 140, jy + 30);
      }
    }
    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowData, compareResult, showExpected, flagOffContract, showUndetected, selectedDoc, invocationId, data]);



  // Chain replay: reveal nodes in real chronological order on a scrubbable,
  // normalized clock (every node's created_at + duration is persisted, so the
  // timeline is derived — no extra data needed). While replaying, un-revealed
  // nodes stay faintly in place (layout/minimap never shift), currently-executing
  // nodes carry a blue wavefront ring, and ghost overlay nodes are hidden (they
  // never happened, so they have no place on the timeline).
  const playback = useFlowPlayback(displayData.nodes as Node[], displayData.edges);
  // The revealed/running sets are React state that changes ONLY on boundary
  // crossings (the 60fps clock lives in a ref inside the hook), so this remap —
  // and the diagram render it feeds — runs a handful of times per replay, not
  // per frame. That keeps the canvas CSS animations (dashes/spinners/sweeps)
  // alive while the replay plays.
  const canvasData = useMemo(() => {
    if (!playback.active) return displayData;
    const fade = { transition: 'opacity 300ms ease' };
    const nodes = displayData.nodes
      .filter(n => !String(n.id).startsWith('ghost-'))
      .map(n => {
        if (!playback.revealed.has(n.id)) {
          return {
            ...n,
            style: { ...n.style, ...fade, opacity: 0.05, pointerEvents: 'none' as const },
            selectable: false,
          };
        }
        // Currently busy at the clock's position: wavefront ring (visible zoomed
        // out) + in-card spinner and activity sweep (via replayRunning). Waiting
        // = finished executing but its downstream delivery is still in flight;
        // same indicators, annotated on the card as delivering.
        return playback.running.has(n.id)
          ? {
              ...n,
              className: `${n.className ?? ''} rounded-lg ring-2 ring-blue-400/60`,
              style: { ...n.style, ...fade, opacity: 1 },
              data: { ...n.data, replayRunning: true, replayWaiting: playback.waiting.has(n.id) },
            }
          : { ...n, style: { ...n.style, ...fade, opacity: 1 } };
      });
    // Connector grammar: animation means ACTIVITY. An edge gets the animated
    // dashed style only while an endpoint is busy at the clock's position —
    // work is flowing across that connector right now. Settled steps (and the
    // whole canvas outside replay) render solid and still: past tense.
    const edges = displayData.edges
      .filter(e => !String(e.id).startsWith('ghost-'))
      .map(e => {
        if (!playback.revealed.has(e.source) || !playback.revealed.has(e.target)) {
          return { ...e, style: { ...e.style, opacity: 0.04 }, animated: false };
        }
        return playback.running.has(e.source) || playback.running.has(e.target)
          ? { ...e, animated: true }
          : e;
      });
    return { nodes, edges };
  }, [displayData, playback.active, playback.revealed, playback.running, playback.waiting]);

  const startReplay = () => {
    playback.start();
    // Show the whole chain before it lights up.
    setTimeout(() => {
      reactFlowInstance?.fitView({ padding: 0.2, duration: 400, maxZoom: 1.5, minZoom: 0.1 });
    }, 50);
  };

  // Drawer cross-navigation: swap the open drawer to any canvas node by id, pan the
  // canvas to it, and hand the event drawer its job nodes so its rows are one-click jumps.
  const handleOpenNodeId = (nodeId: string) => {
    const target = displayData.nodes.find(n => n.id === nodeId);
    if (target) {
      if (selectedNode && selectedNode.id !== target.id) {
        setDrawerHistory(h => [...h, selectedNode]);
      }
      setSelectedNode(target as Node);
      setDrawerOpen(true);
      centerOnNode(target as Node);
    }
  };
  const handleDrawerBack = () => {
    const prev = drawerHistory[drawerHistory.length - 1];
    if (!prev) return;
    setDrawerHistory(h => h.slice(0, -1));
    // Re-resolve against current display data in case an overlay toggle changed since.
    const live = displayData.nodes.find(n => n.id === prev.id) ?? prev;
    setSelectedNode(live as Node);
    centerOnNode(live as Node);
  };
  const handleDrawerClose = () => {
    setDrawerOpen(false);
    setDrawerHistory([]);
  };
  // Canvas children of a node by type (edge source → target): an event's jobs, a
  // job's triggered invocations. Both drawers list them as one-click jump rows.
  const childNodesFor = (parent: Node | null, type: string): Node[] => {
    if (!parent) return [];
    const targets = new Set(displayData.edges.filter(e => e.source === parent.id).map(e => e.target));
    return displayData.nodes.filter(n => targets.has(n.id) && n.type === type) as Node[];
  };
  const relatedJobsFor = (eventNode: Node | null): Node[] => childNodesFor(eventNode, 'job');
  const triggeredInvocationsFor = (jobNode: Node | null): Node[] => childNodesFor(jobNode, 'invocation');

  // Keyboard layer: arrows/WASD walk selection, Enter/Esc drive the drawer, R/Space/
  // arrows drive the replay, F/+/− the viewport, ?/E/U/O panels and overlays. The
  // full map lives in useFlowHotkeys; ? shows it to the user.
  const cycleSpeed = (dir: 1 | -1) => {
    const s = playback.speed;
    const next =
      dir > 0
        ? SPEED_PRESETS.find(p => p > s + 1e-9)
        : [...SPEED_PRESETS].reverse().find(p => p < s - 1e-9);
    if (next != null) playback.setSpeed(next);
  };
  useFlowHotkeys({
    // ReactFlow's internal nodes carry measured width/height for centering; replay
    // marks un-revealed nodes selectable:false, which also takes them off the
    // keyboard path (the wavefront reveals them into reach).
    getNodes: () => (reactFlowInstance?.getNodes() ?? []).filter(n => n.selectable !== false),
    selectedNode,
    drawerOpen,
    canDrawerBack: drawerHistory.length > 0,
    helpOpen,
    playback,
    onNavigate: node => {
      setSelectedNode(node);
      centerOnNode(node, { drawer: drawerOpen, keepZoom: true });
    },
    onOpenDrawer: () => {
      if (!selectedNode) return;
      setDrawerOpen(true);
      setDrawerHistory([]);
      centerOnNode(selectedNode, { drawer: true, keepZoom: true });
    },
    onCloseDrawer: handleDrawerClose,
    onDrawerBack: handleDrawerBack,
    onClearSelection: () => setSelectedNode(null),
    onStartReplay: startReplay,
    onFitView: () => reactFlowInstance?.fitView({ padding: 0.2, duration: 500, maxZoom: 1.5, minZoom: 0.1 }),
    onZoom: dir =>
      dir > 0 ? reactFlowInstance?.zoomIn({ duration: 200 }) : reactFlowInstance?.zoomOut({ duration: 200 }),
    onFocusSearch: () => searchInputRef.current?.focus(),
    onToggleHelp: open => setHelpOpen(o => (open == null ? !o : open)),
    onToggleFlag: key =>
      setFlag(key, !(key === 'expected' ? showExpected : key === 'offcontract' ? flagOffContract : showUndetected)),
    onCycleSpeed: cycleSpeed,
  });

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
          ref={searchInputRef}
          type='text'
          placeholder='Search nodes...'
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
          className='px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white text-sm w-56'
          title='Focus with / — Esc to leave'
        />
        {playback.hasTimeline && !playback.active && (
          <button
            onClick={startReplay}
            className='inline-flex items-center gap-1.5 px-2.5 py-2 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
            title='Replay this chain in the order it actually executed (R)'
          >
            <PlayIcon className='h-3.5 w-3.5 text-blue-600 dark:text-blue-400' />
            Replay
          </button>
        )}
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
        <label className='inline-flex items-center gap-1.5 px-2.5 py-2 text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700'>
          <input
            type='checkbox'
            checked={showUndetected}
            onChange={e => setFlag('undetected', e.target.checked)}
            className='h-3.5 w-3.5 text-gray-500 border-gray-300 rounded'
          />
          Show undetected
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
        <button
          onClick={() => setHelpOpen(true)}
          className='px-2.5 py-2 text-xs font-mono font-semibold border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
          title='Keyboard shortcuts (?)'
          aria-label='Keyboard shortcuts'
        >
          ?
        </button>
      </div>

      {/* Wrong-doc warning: comparing this run against a doc for a different kit */}
      {(showExpected || flagOffContract) && selectedDoc && data?.invocations_by_pk?.source_function && (() => {
        const fn = data.invocations_by_pk!.source_function.toLowerCase();
        const stem = selectedDoc.title.toLowerCase().split(' ')[0];
        return !fn.includes(stem) && !stem.includes(fn) ? (
          <div className='absolute top-16 left-4 z-10 max-w-xl px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-900/30 dark:border-amber-700 text-xs text-amber-800 dark:text-amber-300 shadow-sm'>
            Flow doc “{selectedDoc.title}” doesn’t look like it belongs to function “
            {data.invocations_by_pk!.source_function}” — most “never ran” warnings below are probably
            just the wrong doc. Pick this function’s committed flow doc.
          </div>
        ) : null;
      })()}

      {/* Overlay legend + summary (only when a toggle is active) */}
      {(compareResult || showUndetected) && (showExpected || flagOffContract || showUndetected) && (
        <div className='absolute top-4 right-4 z-10 bg-white/90 dark:bg-gray-800/90 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 shadow-sm space-y-1'>
          {compareResult && (
            <div className='text-[11px] text-gray-600 dark:text-gray-300 pb-1 border-b border-gray-100 dark:border-gray-700'>
              {compareResult.summary.matched}/{compareResult.summary.expectedTotal} matched ·{' '}
              {compareResult.summary.failed} failed · {compareResult.summary.missing} missing ·{' '}
              {compareResult.summary.unexpected} off-contract
            </div>
          )}
          {showExpected && (
            <div className='flex items-center gap-2 text-[11px] text-gray-600 dark:text-gray-300'>
              <span className='w-3 h-3 rounded border-2 border-dashed border-amber-500' /> never ran — doc/code drift?
            </div>
          )}
          {showUndetected && (
            <div className='flex items-center gap-2 text-[11px] text-gray-600 dark:text-gray-300'>
              <span className='w-3 h-3 rounded border-2 border-dashed border-gray-400' /> ran · not detected
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
        nodes={canvasData.nodes}
        edges={canvasData.edges}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        nodeTypes={nodeTypes}
        connectionMode={ConnectionMode.Loose}
        defaultViewport={DEFAULT_VIEWPORT}
        minZoom={0.1}
        maxZoom={2}
        attributionPosition="bottom-left"
        nodesDraggable={true}
        nodesConnectable={false}
        elementsSelectable={true}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        // The keyboard belongs to useFlowHotkeys: ReactFlow's a11y default binds
        // arrows to MOVE the focused node (we walk selection instead), and nothing
        // on this read-only canvas should ever be deletable from the keyboard.
        disableKeyboardA11y
        deleteKeyCode={null}
      >
        <Background gap={20} className='bg-gray-50 dark:bg-gray-900' />
        <Controls className='bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700' />
        <MiniMap
          className='bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700'
          nodeColor={minimapNodeColor}
        />
      </ReactFlow>
      )}

      {/* Compact chain stats (replaces the old page-header KPI tiles) */}
      <FlowStatsPill invocations={invocations} nodes={displayData.nodes as Node[]} />

      {/* Replay transport: play/pause + scrubbable timeline (bottom edge) */}
      {playback.active && <FlowPlaybackBar playback={playback} drawerOpen={drawerOpen && !!selectedNode} />}

      {/* Path breadcrumb: origin → … → selected node, follows every selection change
          (including keyboard-only selection, where the drawer stays closed) */}
      <FlowBreadcrumb
        selectedNode={selectedNode}
        nodes={displayData.nodes as Node[]}
        edges={displayData.edges}
        onSelect={handleOpenNodeId}
        lifted={playback.active}
        drawerOpen={drawerOpen && !!selectedNode}
      />

      {/* Detail Drawer - Type-specific modals */}
      <AnimatePresence>
        {drawerOpen && selectedNode && (
          <>
            {selectedNode.type === 'invocation' && (
              <InvocationDetailDrawer
                node={selectedNode}
                isOpen={drawerOpen}
                onClose={handleDrawerClose}
                onOpenNodeId={handleOpenNodeId}
                onBack={drawerHistory.length > 0 ? handleDrawerBack : undefined}
              />
            )}
            {selectedNode.type === 'job' && (
              <JobDetailDrawer
                node={selectedNode}
                isOpen={drawerOpen}
                onClose={handleDrawerClose}
                onOpenNodeId={handleOpenNodeId}
                onBack={drawerHistory.length > 0 ? handleDrawerBack : undefined}
                triggeredInvocations={triggeredInvocationsFor(selectedNode)}
              />
            )}
            {selectedNode.type === 'event' && (
              <EventDetailDrawer
                node={selectedNode}
                isOpen={drawerOpen}
                onClose={handleDrawerClose}
                relatedJobs={relatedJobsFor(selectedNode)}
                onOpenNodeId={handleOpenNodeId}
                onBack={drawerHistory.length > 0 ? handleDrawerBack : undefined}
              />
            )}
          </>
        )}
      </AnimatePresence>

      {/* Hotkey reference (toggled by ? or the toolbar button) */}
      {helpOpen && <KeyboardShortcutsOverlay onClose={() => setHelpOpen(false)} />}
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