import React from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { SignalIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { formatDuration } from '../../utils/formatDuration';
import { useRunningDuration } from '../../hooks/useRunningDuration';
import { NodeShell, CountBadge, StatusGlyph } from './NodeShell';

export interface EventNodeData {
  eventName: string;
  /** Overlay ghost: declared in the flow doc and/or a ran-but-false detector.
   *  Renders the SAME shell/dimensions — only border/label state differs. */
  ghost?: boolean;
  /** Meta text for the ghost state: 'ran · not detected' (detector evaluated false)
   *  vs the drift warning 'never ran' (in the flow doc, but NO record exists). */
  ghostLabel?: string;
  /** 'warning' renders the drift state (amber): the contract says this detector
   *  should have evaluated on every invocation, and there is no record of it. */
  ghostTone?: 'neutral' | 'warning';
  correlationId: string;
  detected: boolean;
  status: string;
  detectionDuration: number;
  handlerDuration?: number;
  jobsCount: number;
  hasFailedJobs: boolean;
  createdAt?: string;
  updatedAt?: string;
  /** Replay: executing at the replay clock's position (spinner + activity sweep). */
  replayRunning?: boolean;
}

const DRIFT_TITLE =
  'Every registered detector runs on every invocation. No record exists for this event — the deployed code and the flow doc disagree (stale doc, undeployed code, or a lost observability write).';

export const EventNode: React.FC<NodeProps<EventNodeData>> = ({ data, selected }) => {
  const isDetected = data.detected;
  const hasErrors = isDetected && data.hasFailedJobs;

  const liveDetectionDuration = useRunningDuration({
    status: data.status,
    createdAt: data.createdAt,
    completedDurationMs: data.detectionDuration,
  });

  if (data.ghost) {
    const warn = data.ghostTone === 'warning';
    return (
      <NodeShell
        tone={warn ? 'amber' : 'gray'}
        icon={warn ? <ExclamationTriangleIcon className='w-4 h-4' /> : <SignalIcon className='w-4 h-4' />}
        kindLabel='Event'
        title={data.eventName}
        selected={selected}
        dashed
        dimmed={!warn}
        meta={
          <span className={warn ? 'text-amber-700 dark:text-amber-400' : undefined} title={warn ? DRIFT_TITLE : undefined}>
            {data.ghostLabel ?? 'expected · not observed'}
          </span>
        }
        minWidthClass='min-w-[210px]'
      >
        <Handle type='target' position={Position.Left} className='w-3 h-3' />
        <Handle type='source' position={Position.Right} className='w-3 h-3' />
      </NodeShell>
    );
  }

  return (
    <NodeShell
      tone='green'
      icon={<SignalIcon className='w-4 h-4' />}
      kindLabel='Event'
      title={data.eventName}
      selected={selected}
      failed={hasErrors}
      dimmed={!isDetected}
      running={data.replayRunning}
      statusArea={
        isDetected ? (
          <StatusGlyph
            status={data.replayRunning ? 'running' : hasErrors ? 'failed' : data.status}
            title={hasErrors && !data.replayRunning ? 'a job failed' : undefined}
          />
        ) : undefined
      }
      meta={
        isDetected ? (
          <>
            detection {formatDuration(liveDetectionDuration)}
            {data.handlerDuration != null && ` · handler ${formatDuration(data.handlerDuration)}`}
          </>
        ) : (
          'ran · not detected'
        )
      }
      minWidthClass='min-w-[210px]'
    >
      <Handle type='target' position={Position.Left} className='w-3 h-3' />
      {isDetected && (
        <>
          <Handle type='source' position={Position.Right} className='w-3 h-3' />
          <div className='absolute -right-2 top-1/2 -translate-y-1/2 translate-x-full'>
            <CountBadge>
              {data.jobsCount} job{data.jobsCount === 1 ? '' : 's'}
            </CountBadge>
          </div>
        </>
      )}
    </NodeShell>
  );
};

export default EventNode;
