import React from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { BoltIcon } from '@heroicons/react/24/outline';
import { formatDuration } from '../../utils/formatDuration';
import { useRunningDuration } from '../../hooks/useRunningDuration';
import SourceChip from '../SourceChip';
import { NodeShell, NodeBadge, CountBadge, StatusGlyph } from './NodeShell';

export interface InvocationNodeData {
  sourceFunction: string;
  sourceSystem?: string | null;
  sourceType?: string | null;
  correlationId: string;
  status: string;
  duration: number;
  eventsCount: number;
  events?: any[];
  detectedEvents?: any[];
  undetectedEvents?: any[];
  createdAt?: string;
  updatedAt?: string;
  /** No source_job_id — the root cause of every downstream node in this chain. */
  isOrigin?: boolean;
  /** The invocation the user navigated here with ("you are here"). */
  isFocus?: boolean;
  /** Replay: executing at the replay clock's position (spinner + activity sweep). */
  replayRunning?: boolean;
}

export const InvocationNode: React.FC<NodeProps<InvocationNodeData>> = ({ data, selected }) => {
  const liveDuration = useRunningDuration({
    status: data.status,
    createdAt: data.createdAt,
    completedDurationMs: data.duration,
  });

  return (
    <NodeShell
      tone='blue'
      icon={<BoltIcon className='w-4 h-4' />}
      kindLabel='Invocation'
      title={data.sourceFunction}
      selected={selected}
      focused={data.isFocus}
      failed={data.status === 'failed'}
      running={data.replayRunning}
      badges={
        <>
          {data.isOrigin && (
            <NodeBadge tone='blue' title='Chain origin — no parent job caused this invocation; everything downstream traces back here.'>
              ORIGIN
            </NodeBadge>
          )}
          {data.isFocus && !data.isOrigin && (
            <NodeBadge title='The invocation you navigated here with.'>VIEWING</NodeBadge>
          )}
        </>
      }
      statusArea={
        <>
          <SourceChip sourceType={data.sourceType} sourceSystem={data.sourceSystem} compact />
          <StatusGlyph status={data.replayRunning ? 'running' : data.status} />
        </>
      }
      meta={
        <>
          {formatDuration(liveDuration)} · {data.eventsCount} event{data.eventsCount === 1 ? '' : 's'}
        </>
      }
      minWidthClass='min-w-[230px]'
    >
      <Handle type='target' position={Position.Left} id='left' className='w-3 h-3' />
      <Handle type='source' position={Position.Right} id='right' className='w-3 h-3' />
      <Handle type='source' position={Position.Bottom} id='bottom' className='w-3 h-3' />

      {data.eventsCount > 0 && (
        <div className='absolute -right-2 top-1/2 -translate-y-1/2 translate-x-full'>
          <CountBadge>
            {data.eventsCount} event{data.eventsCount === 1 ? '' : 's'}
          </CountBadge>
        </div>
      )}
    </NodeShell>
  );
};

export default InvocationNode;
