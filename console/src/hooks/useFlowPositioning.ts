import { useMemo } from 'react';
import { Node, Edge, MarkerType } from 'reactflow';

// Layout constants. Node heights are the MEASURED rendered heights of each node
// type (offsetHeight at zoom 1) — the extent algorithm below reserves real
// vertical room per node, so nothing can overlap regardless of fan-out shape.
const HORIZONTAL_SPACING = 450; // space between node columns
const NODE_H: Record<'invocation' | 'event' | 'job', number> = {
  invocation: 124,
  event: 92,
  job: 88,
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

    const detectedOf = (inv: Invocation) => (inv.event_executions || []).filter(e => e.detected);
    const resolveTriggered = (job: JobExecution): Invocation[] =>
      (job.triggered_invocations || [])
        .map(ref => invocations.find(inv => inv.id === ref.id))
        .filter((inv): inv is Invocation => Boolean(inv));

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
      const childSum = (event.job_executions || []).reduce((sum, j) => sum + measureJob(j), 0);
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

    const rootInvocations = invocations.filter(inv => !inv.source_job_id);
    const childInvocations = invocations.filter(inv => inv.source_job_id);
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
      const detectedEvents = events.filter(e => e.detected);
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
          animated: true,
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
          animated: true,
          style: { stroke: '#10b981', strokeWidth: 2 }, // green for events
          markerEnd: arrow,
        });

        // Jobs: same banding, centered on the event.
        const jobs = event.job_executions || [];
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
            animated: true,
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
                animated: true,
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

    // Deduplicate edges to prevent duplicate key warnings
    const uniqueEdges = edges.filter((edge, index, self) => index === self.findIndex(e => e.id === edge.id));

    return { nodes, edges: uniqueEdges };
  }, [invocations, horizontalSpacing, verticalGap]);
};
