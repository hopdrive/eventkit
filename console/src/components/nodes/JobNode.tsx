import React from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { Cog6ToothIcon } from '@heroicons/react/24/outline';
import { formatDuration } from '../../utils/formatDuration';
import { useRunningDuration } from '../../hooks/useRunningDuration';
import { NodeShell, StatusGlyph } from './NodeShell';

export interface JobNodeData {
  jobName: string;
  /** Expected-overlay ghost — same shell/dimensions, declared-but-not-run state. */
  ghost?: boolean;
  functionName?: string;
  correlationId: string;
  status: string;
  duration: number;
  result?: any;
  error?: string;
  triggersInvocation?: boolean;
  isSourceJob?: boolean;
  triggeredInvocationsCount?: number;
  createdAt?: string;
  updatedAt?: string;
  /** Replay: executing at the replay clock's position (spinner + activity sweep). */
  replayRunning?: boolean;
  /** Replay: finished executing, but its downstream invocation(s) haven't started
   *  yet — the write/webhook is still being delivered (debounce, event queue). */
  replayWaiting?: boolean;
}

export const JobNode: React.FC<NodeProps<JobNodeData>> = ({ data, selected }) => {
  const liveDuration = useRunningDuration({
    status: data.status,
    createdAt: data.createdAt,
    completedDurationMs: data.duration,
  });

  if (data.ghost) {
    return (
      <NodeShell
        tone='gray'
        icon={<Cog6ToothIcon className='w-4 h-4' />}
        kindLabel='Job'
        title={data.jobName}
        selected={selected}
        dashed
        dimmed
        meta='expected · not observed'
        minWidthClass='min-w-[190px]'
      >
        <Handle type='target' position={Position.Left} className='w-3 h-3' />
      </NodeShell>
    );
  }

  const status = data.status || 'completed';
  const chains = data.triggersInvocation;
  const chainCount = data.triggeredInvocationsCount || 0;
  const needsSourceHandle = chains || data.isSourceJob;

  return (
    <NodeShell
      tone='purple'
      icon={<Cog6ToothIcon className='w-4 h-4' />}
      kindLabel='Job'
      title={data.jobName}
      selected={selected}
      failed={status === 'failed'}
      running={data.replayRunning}
      statusArea={<StatusGlyph status={data.replayRunning ? 'running' : status} />}
      meta={
        <>
          {formatDuration(liveDuration)}
          {status === 'failed' && <span className='text-red-600 dark:text-red-400'> · failed</span>}
        </>
      }
      footer={
        data.replayWaiting ? (
          <span className='text-blue-500 dark:text-blue-400' title='The job finished; its write/webhook is still being delivered to the next invocation (debounce, event queue).'>
            delivering to downstream invocation…
          </span>
        ) : chains ? (
          `chains ${chainCount > 0 ? chainCount : 'a'} downstream invocation${chainCount === 1 ? '' : 's'} →`
        ) : data.isSourceJob ? (
          'its write triggered the next invocation →'
        ) : undefined
      }
      minWidthClass='min-w-[190px]'
    >
      <Handle type='target' position={Position.Left} className='w-3 h-3' />
      {/* Always render the handle to avoid ReactFlow timing issues; hide when unused. */}
      <Handle
        type='source'
        position={Position.Right}
        id='right'
        className={`w-3 h-3 ${needsSourceHandle ? '' : 'opacity-0 pointer-events-none'}`}
      />
    </NodeShell>
  );
};

export default JobNode;
