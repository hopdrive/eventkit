// Compact chain stats for the flow canvas — replaces the big KPI tiles that used
// to sit in a page header above the diagram. One quiet pill in the top-right
// corner: kind-colored counts, detail on hover, red only when something failed.

import React from 'react';
import { Node } from 'reactflow';

interface FlowStatsPillProps {
  invocations: Array<{ event_executions?: Array<{ detected: boolean }> | null }>;
  nodes: Node[];
}

const Dot: React.FC<{ className: string }> = ({ className }) => (
  <span className={`inline-block w-1.5 h-1.5 rounded-full ${className}`} />
);

const FlowStatsPill: React.FC<FlowStatsPillProps> = ({ invocations, nodes }) => {
  if (invocations.length === 0) return null;

  const invocationCount = nodes.filter(n => n.type === 'invocation' && !n.data?.ghost).length;
  const jobNodes = nodes.filter(n => n.type === 'job' && !n.data?.ghost);
  const jobsOk = jobNodes.filter(n => n.data?.status === 'completed').length;
  const jobsFailed = jobNodes.filter(n => n.data?.status === 'failed').length;
  const jobsRunning = jobNodes.filter(n => n.data?.status === 'running').length;

  let totalEvents = 0;
  let detectedEvents = 0;
  for (const inv of invocations) {
    for (const ev of inv.event_executions ?? []) {
      totalEvents++;
      if (ev.detected) detectedEvents++;
    }
  }

  return (
    <div className='absolute top-3 right-3 z-40'>
      <div className='flex items-center gap-3 px-3 py-1.5 rounded-lg bg-white/95 dark:bg-gray-800/95 border border-gray-200 dark:border-gray-700 shadow-sm backdrop-blur text-xs text-gray-600 dark:text-gray-300 whitespace-nowrap'>
        <span className='flex items-center gap-1.5' title='Invocations in this chain'>
          <Dot className='bg-blue-500' />
          <span className='font-semibold text-gray-900 dark:text-white'>{invocationCount}</span>
          invocation{invocationCount === 1 ? '' : 's'}
        </span>
        <span
          className='flex items-center gap-1.5'
          title={`${detectedEvents} detected of ${totalEvents} detector runs (${totalEvents - detectedEvents} returned false)`}
        >
          <Dot className='bg-green-500' />
          <span className='font-semibold text-gray-900 dark:text-white'>
            {detectedEvents}/{totalEvents}
          </span>
          events
        </span>
        <span
          className='flex items-center gap-1.5'
          title={`${jobsOk} succeeded${jobsFailed ? `, ${jobsFailed} failed` : ''}${jobsRunning ? `, ${jobsRunning} running` : ''} of ${jobNodes.length} jobs`}
        >
          <Dot className={jobsFailed > 0 ? 'bg-red-500' : 'bg-purple-500'} />
          <span className={`font-semibold ${jobsFailed > 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'}`}>
            {jobsOk}/{jobNodes.length}
          </span>
          jobs ok
          {jobsFailed > 0 && <span className='text-red-600 dark:text-red-400 font-semibold'>· {jobsFailed} failed</span>}
          {jobsRunning > 0 && <span className='text-blue-600 dark:text-blue-400'>· {jobsRunning} running</span>}
        </span>
      </div>
    </div>
  );
};

export default FlowStatsPill;
