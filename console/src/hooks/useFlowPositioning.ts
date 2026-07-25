import { useMemo } from 'react';
import { Node, Edge, MarkerType } from 'reactflow';

// Layout constants. Node heights are the MEASURED rendered heights of each node
// type (offsetHeight at zoom 1) — the extent algorithm below reserves real
// vertical room per node, so nothing can overlap regardless of fan-out shape.
const HORIZONTAL_SPACING = 450; // space between node columns
const NODE_H: Record<'invocation' | 'event' | 'job', number> = {
  invocation: 84,
  event: 84,
  job: 102, // chained jobs carry a footer line
};
const V_GAP = 48; // even, consistent padding between vertically adjacent nodes
const ROOT_GAP = 140; // extra separation between independent root chains

interface PositioningConfig {
  horizontalSpacing?: number;
  /** Vertical padding between adjacent nodes (default 48). */
  verticalGap?: number;
}

interface JobExecution {
  id: string;
  job_name: string;
  job_function_name?: string;
  correlation_id?: string;
  status: string;
  duration_ms?: number;
  result?: any;
  error_message?: string;
  created_at: string;
  updated_at?: string;
  triggered_invocations?: Array<{
    id: string;
    correlation_id: string;
  }>;
}

interface EventExecution {
  id: string;
  event_name: string;
  correlation_id?: string;
  detected: boolean;
  status: string;
  detection_duration_ms?: number;
  handler_duration_ms?: number;
  created_at: string;
  updated_at?: string;
  job_executions?: JobExecution[];
}

interface Invocation {
  id: string;
  source_function: string;
  source_system?: string | null;
  source_type?: string | null;
  correlation_id: string;
  status: string;
  total_duration_ms: number;
  created_at: string;
  updated_at?: string;
  event_executions?: EventExecution[];
  source_job_id?: string;
  source_job_execution?: JobExecution;
  correlated_invocations?: Invocation[];
  // Chain-root provenance. `context_data.origin` is the decoded client origin the
  // origin-decoder plugin injected (arbitrary JSON, may be absent/malformed); the
  // source_* fields are who triggered the root and when.
  context_data?: unknown;
  source_event_time?: string | null;
  source_user_email?: string | null;
  source_user_role?: string | null;
}

// The decoded client origin the origin-decoder plugin persisted into
// context_data.origin. Arbitrary/consumer-shaped and never trusted: return only a
// non-empty object or a non-empty string, and skip null/array/number/junk so a
// malformed origin can never spawn a broken node.
export function readOrigin(contextData: unknown): Record<string, unknown> | string | undefined {
  if (!contextData || typeof contextData !== 'object') return undefined;
  const origin = (contextData as { origin?: unknown }).origin;
  if (typeof origin === 'string') return origin.length > 0 ? origin : undefined;
  if (origin && typeof origin === 'object' && !Array.isArray(origin)) {
    return Object.keys(origin).length > 0 ? (origin as Record<string, unknown>) : undefined;
  }
  return undefined;
}

// The click that started the chain. `clickId` is identical across every chain one
// user click caused, so the canvas groups roots by it. Client-supplied, so it is a
// display-only grouping key, never chain identity (each chain keeps its correlation id).
export function originClickId(contextData: unknown): string | null {
  const origin = readOrigin(contextData);
  if (origin && typeof origin === 'object') {
    const clickId = (origin as Record<string, unknown>).clickId;
    if (typeof clickId === 'string' && clickId.length > 0) return clickId;
  }
  return null;
}

export interface PositionedNode extends Node {
  position: { x: number; y: number };
}

export interface FlowData {
  nodes: PositionedNode[];
  edges: Edge[];
}

/**
 * Flow layout hook — extent-based tidy tree.
 *
 * Every node owns a vertical BAND at least (node height + gap) tall; a parent's
 * band is the sum of its children's bands (or its own minimum if larger). Bands
 * nest recursively through invocation → events → jobs → triggered invocations,
 * so two adjacent fan-outs can never overlap: each already reserved the room its
 * whole subtree needs. Children are centered on their parent's band center,
 * which keeps single-child chains on one straight line.
 */
export const useFlowPositioning = (invocations: Invocation[], config: PositioningConfig = {}): FlowData => {
  const { horizontalSpacing = HORIZONTAL_SPACING, verticalGap = V_GAP } = config;

  return useMemo(() => {
    const nodes: PositionedNode[] = [];
    const edges: Edge[] = [];

    // Siblings read chronologically top→bottom: a fan-out (one monolithic job
    // chaining many invocations) becomes a visual timeline of what fired first.
    // Both passes MUST iterate in this same order — measuring and placement walk
    // the same DFS, and the visited-set bookkeeping depends on it.
    const byCreatedAt = <T extends { created_at: string }>(items: T[]): T[] =>
      [...items].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    const detectedOf = (inv: Invocation) => byCreatedAt((inv.event_executions || []).filter(e => e.detected));
    const jobsOf = (event: EventExecution) => byCreatedAt(event.job_executions || []);
    const resolveTriggered = (job: JobExecution): Invocation[] =>
      byCreatedAt(
        (job.triggered_invocations || [])
          .map(ref => invocations.find(inv => inv.id === ref.id))
          .filter((inv): inv is Invocation => Boolean(inv))
      );

    // ── Pass 1: measure subtree band heights ────────────────────────────────
    // The visited set mirrors placement order exactly (same DFS from the same
    // roots), so a chained invocation is measured — and later placed — under
    // the FIRST job that references it, and costs 0 elsewhere.
    const invBand = new Map<string, number>();
    const eventBand = new Map<string, number>();
    const jobBand = new Map<string, number>();
    const measured = new Set<string>();

    const measureInvocation = (inv: Invocation): number => {
      if (measured.has(inv.id)) return 0;
      measured.add(inv.id);
      const childSum = detectedOf(inv).reduce((sum, e) => sum + measureEvent(e), 0);
      const band = Math.max(NODE_H.invocation + verticalGap, childSum);
      invBand.set(inv.id, band);
      return band;
    };
    const measureEvent = (event: EventExecution): number => {
      const childSum = jobsOf(event).reduce((sum, j) => sum + measureJob(j), 0);
      const band = Math.max(NODE_H.event + verticalGap, childSum);
      eventBand.set(event.id, band);
      return band;
    };
    const measureJob = (job: JobExecution): number => {
      const childSum = resolveTriggered(job).reduce((sum, t) => sum + measureInvocation(t), 0);
      const band = Math.max(NODE_H.job + verticalGap, childSum);
      jobBand.set(job.id, band);
      return band;
    };

    const rootInvocations = byCreatedAt(invocations.filter(inv => !inv.source_job_id));
    const childInvocations = byCreatedAt(invocations.filter(inv => inv.source_job_id));
    rootInvocations.forEach(measureInvocation);
    childInvocations.forEach(inv => {
      if (!measured.has(inv.id)) measureInvocation(inv);
    });

    // ── Pass 2: place nodes within their bands ──────────────────────────────
    const processed = new Set<string>();

    const arrow = { type: MarkerType.ArrowClosed, width: 20, height: 20 };

    const placeInvocation = (invocation: Invocation, baseX: number, bandTop: number) => {
      if (processed.has(invocation.id)) return;
      processed.add(invocation.id);

      const band = invBand.get(invocation.id) ?? NODE_H.invocation + verticalGap;
      const centerY = bandTop + band / 2;

      const events = invocation.event_executions || [];
      const detectedEvents = detectedOf(invocation); // sorted — same order the measure pass used
      const undetectedEvents = events.filter(e => !e.detected);

      nodes.push({
        id: invocation.id,
        type: 'invocation',
        position: { x: baseX, y: centerY - NODE_H.invocation / 2 },
        data: {
          sourceFunction: invocation.source_function,
          sourceSystem: invocation.source_system,
          sourceType: invocation.source_type,
          correlationId: invocation.correlation_id,
          status: invocation.status,
          duration: invocation.total_duration_ms,
          eventsCount: detectedEvents.length,
          events: events,
          detectedEvents: detectedEvents,
          undetectedEvents: undetectedEvents,
          createdAt: invocation.created_at,
          updatedAt: invocation.updated_at,
        },
      });

      // Source job for a chain root that arrived with its parent job preloaded
      // (chained invocations placed recursively already have their job node).
      if (invocation.source_job_id && invocation.source_job_execution) {
        const sj = invocation.source_job_execution;
        if (!nodes.some(n => n.id === `job-${invocation.source_job_id}`)) {
          nodes.push({
            id: `job-${invocation.source_job_id}`,
            type: 'job',
            position: { x: baseX - horizontalSpacing, y: centerY - NODE_H.job / 2 },
            data: {
              jobName: sj.job_name,
              functionName: sj.job_function_name,
              correlationId: sj.correlation_id,
              status: sj.status,
              duration: sj.duration_ms,
              result: sj.result,
              error: sj.error_message,
              triggersInvocation: (sj.triggered_invocations?.length ?? 0) > 0,
              isSourceJob: true,
              createdAt: sj.created_at,
              updatedAt: sj.updated_at,
            },
          });
        }
        edges.push({
          id: `job-${invocation.source_job_id}-to-${invocation.id}`,
          source: `job-${invocation.source_job_id}`,
          sourceHandle: 'right',
          target: invocation.id,
          targetHandle: 'left',
          type: 'default',
          animated: false, // animation means ACTIVITY — only the replay marks live edges animated
          style: { stroke: '#3b82f6', strokeWidth: 2 }, // blue for invocations
          markerEnd: arrow,
        });
      }

      // Events: allocate each detected event its measured band, centered on the
      // invocation's band center.
      const eventsTotal = detectedEvents.reduce((s, e) => s + (eventBand.get(e.id) ?? 0), 0);
      let eventCursor = centerY - eventsTotal / 2;
      const eventX = baseX + horizontalSpacing + 80;

      for (const event of detectedEvents) {
        const eBand = eventBand.get(event.id) ?? NODE_H.event + verticalGap;
        const eCenter = eventCursor + eBand / 2;
        eventCursor += eBand;

        nodes.push({
          id: `event-${event.id}`,
          type: 'event',
          position: { x: eventX, y: eCenter - NODE_H.event / 2 },
          data: {
            eventName: event.event_name,
            correlationId: event.correlation_id,
            detected: event.detected,
            status: event.status,
            detectionDuration: event.detection_duration_ms,
            handlerDuration: event.handler_duration_ms,
            jobsCount: event.job_executions?.length || 0,
            hasFailedJobs: (event.job_executions || []).some((job: JobExecution) => job.status === 'failed'),
            createdAt: event.created_at,
            updatedAt: event.updated_at,
          },
        });

        edges.push({
          id: `${invocation.id}-to-event-${event.id}`,
          source: invocation.id,
          sourceHandle: 'right',
          target: `event-${event.id}`,
          type: 'default',
          animated: false, // animation means ACTIVITY — only the replay marks live edges animated
          style: { stroke: '#10b981', strokeWidth: 2 }, // green for events
          markerEnd: arrow,
        });

        // Jobs: same banding, centered on the event.
        const jobs = jobsOf(event);
        const jobsTotal = jobs.reduce((s, j) => s + (jobBand.get(j.id) ?? 0), 0);
        let jobCursor = eCenter - jobsTotal / 2;
        const jobX = eventX + horizontalSpacing;

        for (const job of jobs) {
          const jBand = jobBand.get(job.id) ?? NODE_H.job + verticalGap;
          const jCenter = jobCursor + jBand / 2;
          jobCursor += jBand;

          nodes.push({
            id: `job-${job.id}`,
            type: 'job',
            position: { x: jobX, y: jCenter - NODE_H.job / 2 },
            data: {
              jobName: job.job_name,
              functionName: job.job_function_name,
              correlationId: job.correlation_id,
              status: job.status,
              duration: job.duration_ms,
              result: job.result,
              error: job.error_message,
              triggersInvocation: job.triggered_invocations && job.triggered_invocations.length > 0,
              triggeredInvocationsCount: job.triggered_invocations?.length || 0,
              createdAt: job.created_at,
              updatedAt: job.updated_at,
            },
          });

          edges.push({
            id: `event-${event.id}-to-job-${job.id}`,
            source: `event-${event.id}`,
            target: `job-${job.id}`,
            type: 'default',
            animated: false, // animation means ACTIVITY — only the replay marks live edges animated
            style: { stroke: '#8b5cf6', strokeWidth: 2 }, // purple for jobs
            markerEnd: arrow,
          });

          // Chained invocations triggered by this job: each gets its measured
          // band to the right of the job, centered on the job.
          const triggered = resolveTriggered(job);
          if (triggered.length > 0) {
            const trigTotal = triggered.reduce(
              (s, t) => s + (processed.has(t.id) ? 0 : invBand.get(t.id) ?? 0),
              0
            );
            let trigCursor = jCenter - trigTotal / 2;

            for (const t of triggered) {
              if (!processed.has(t.id)) {
                const tBand = invBand.get(t.id) ?? NODE_H.invocation + verticalGap;
                placeInvocation(t, jobX + horizontalSpacing, trigCursor);
                trigCursor += tBand;
              }
              edges.push({
                id: `job-${job.id}-to-invocation-${t.id}`,
                source: `job-${job.id}`,
                sourceHandle: 'right',
                target: t.id,
                targetHandle: 'left',
                type: 'default',
                animated: false, // animation means ACTIVITY — only the replay marks live edges animated
                style: { stroke: '#3b82f6', strokeWidth: 2 }, // blue for invocations
                markerEnd: arrow,
              });
            }
          }
        }
      }
    };

    // Roots stack their full subtree bands; independent chains get extra air.
    let rootCursor = 60;
    for (const invocation of rootInvocations) {
      const band = invBand.get(invocation.id) ?? NODE_H.invocation + verticalGap;
      placeInvocation(invocation, 200, rootCursor);
      rootCursor += band + ROOT_GAP;
    }
    // Child invocations not reached through a job chain (edge case: passed directly).
    for (const invocation of childInvocations) {
      if (!processed.has(invocation.id)) {
        const band = invBand.get(invocation.id) ?? NODE_H.invocation + verticalGap;
        placeInvocation(invocation, 200, rootCursor);
        rootCursor += band + ROOT_GAP;
      }
    }

    // ── Origin fan-out (userAction) ─────────────────────────────────────────
    // A synthetic node to the LEFT of the chain ROOTS it started. One user click can
    // start several chains: they share `context_data.origin.clickId` but each keeps its
    // own server-minted correlation id, so roots are grouped by clickId and ONE node
    // fans an edge into every root in the group. A root whose origin has no clickId
    // stays one-node-per-root (the common case). Named "userAction" to avoid clashing
    // with the InvocationNode ORIGIN badge (that marks the chain root itself; this marks
    // the client action that started it). clickId is client-supplied, so this grouping
    // is display only, never chain identity.
    const ROOT_X = 200; // the x the root-placement loops below use as baseX
    interface OriginRoot {
      id: string;
      sourceFunction: string;
      correlationId: string;
    }
    interface OriginGroup {
      clickId: string | null;
      roots: OriginRoot[];
      // Representative (earliest root) for the card's what/who/when.
      origin: Record<string, unknown> | string;
      userEmail: string | null;
      userRole: string | null;
      eventTime: string | null;
      createdAt: string;
    }
    const originGroups = new Map<string, OriginGroup>();
    for (const inv of byCreatedAt(invocations.filter(i => !i.source_job_id))) {
      if (!processed.has(inv.id)) continue; // only roots actually placed on the canvas
      const origin = readOrigin(inv.context_data);
      if (origin === undefined) continue;
      const clickId = originClickId(inv.context_data);
      const key = clickId ? `click:${clickId}` : `root:${inv.id}`;
      const root: OriginRoot = { id: inv.id, sourceFunction: inv.source_function, correlationId: inv.correlation_id };
      const existing = originGroups.get(key);
      if (existing) {
        existing.roots.push(root);
      } else {
        originGroups.set(key, {
          clickId,
          roots: [root],
          origin,
          userEmail: inv.source_user_email ?? null,
          userRole: inv.source_user_role ?? null,
          eventTime: inv.source_event_time ?? null,
          // Reveal with the chain roots during replay (zero duration), not faded out.
          createdAt: inv.source_event_time ?? inv.created_at,
        });
      }
    }

    const rootCenterY = (rootId: string): number | null => {
      const n = nodes.find(nn => nn.id === rootId);
      return n ? n.position.y + NODE_H.invocation / 2 : null;
    };

    for (const group of originGroups.values()) {
      const centers = group.roots.map(r => rootCenterY(r.id)).filter((y): y is number => y != null);
      if (centers.length === 0) continue;
      const groupCenterY = (Math.min(...centers) + Math.max(...centers)) / 2;
      const originNodeId = group.clickId ? `origin-click-${group.clickId}` : `origin-${group.roots[0].id}`;
      nodes.push({
        id: originNodeId,
        type: 'userAction',
        position: { x: ROOT_X - horizontalSpacing, y: groupCenterY - NODE_H.invocation / 2 },
        data: {
          origin: group.origin,
          userEmail: group.userEmail,
          userRole: group.userRole,
          eventTime: group.eventTime,
          createdAt: group.createdAt,
          clickId: group.clickId,
          // Roots this click started. The drawer lists them; displayData reads the ids to
          // hand the ORIGIN marker from each root to this node.
          rootInvocationIds: group.roots.map(r => r.id),
          roots: group.roots,
        },
      });
      for (const { id: rootId } of group.roots) {
        edges.push({
          id: `origin-${originNodeId}-to-${rootId}`,
          source: originNodeId,
          sourceHandle: 'right',
          target: rootId,
          targetHandle: 'left',
          type: 'default',
          animated: false,
          style: { stroke: '#f59e0b', strokeWidth: 2 }, // amber, the origin edge
          markerEnd: arrow,
        });
      }
    }

    // Deduplicate edges to prevent duplicate key warnings
    const uniqueEdges = edges.filter((edge, index, self) => index === self.findIndex(e => e.id === edge.id));

    return { nodes, edges: uniqueEdges };
  }, [invocations, horizontalSpacing, verticalGap]);
};
