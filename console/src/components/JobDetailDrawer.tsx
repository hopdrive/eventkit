// Job detail drawer — glance-first, zero tabs (see drawer/primitives.tsx for the
// shared design decisions). Everything that explains "what happened when it ran"
// is visible without a click: status, duration, error, result. Logs mount lazily.

import React from 'react';
import { Node } from 'reactflow';
import { DrawerShell, StatusChip, Fact, FactGrid, ErrorPanel, Collapsible, JsonBlock } from './drawer/primitives';
import { formatDuration } from '../utils/formatDuration';
import { formatRelativeTime } from '../utils/formatTime';
import { createGrafanaService } from '../services/GrafanaService';
import LogsViewer from './LogsViewer';

interface JobDetailDrawerProps {
  node: Node | null;
  isOpen: boolean;
  onClose: () => void;
  /** Swap the drawer to another canvas node (cross-navigation). */
  onOpenNodeId?: (nodeId: string) => void;
}

const JobDetailDrawer: React.FC<JobDetailDrawerProps> = ({ node, isOpen, onClose }) => {
  if (!isOpen || !node || node.type !== 'job') return null;
  const d = node.data ?? {};
  const jobExecutionId = String(node.id).replace('job-', '');
  const started = d.createdAt ? new Date(d.createdAt) : undefined;
  const hasResult = d.result !== undefined && d.result !== null;

  return (
    <DrawerShell
      kindLabel='Job'
      kindClass='text-purple-600 dark:text-purple-400'
      title={d.jobName ?? 'job'}
      statusChip={<StatusChip status={d.status} />}
      factStrip={
        <span>
          {formatDuration(d.duration ?? 0)}
          {started && (
            <>
              {' · '}
              <span title={started.toLocaleString()}>{formatRelativeTime(d.createdAt)}</span>
            </>
          )}
          {d.functionName && d.functionName !== d.jobName ? ` · fn ${d.functionName}` : ''}
        </span>
      }
      correlationId={d.correlationId}
      onClose={onClose}
    >
      <ErrorPanel message={d.error} stack={d.errorStack} />

      <FactGrid>
        <Fact label='Execution id' mono span2>
          {jobExecutionId}
        </Fact>
        <Fact label='Duration'>{formatDuration(d.duration ?? 0)}</Fact>
        <Fact label='Started'>{started ? started.toLocaleString() : '—'}</Fact>
        {d.isSourceJob && (
          <Fact label='Role' span2>
            Source job — its DB write triggered the invocation to its right.
          </Fact>
        )}
        {d.triggersInvocation && (
          <Fact label='Chained' span2>
            This job's write triggered {d.triggeredInvocationsCount || 'further'} downstream invocation
            {(d.triggeredInvocationsCount || 2) === 1 ? '' : 's'} — follow its edge on the canvas.
          </Fact>
        )}
      </FactGrid>

      {hasResult ? (
        <div>
          <div className='text-xs font-semibold text-gray-700 dark:text-gray-200 uppercase tracking-wide mb-1.5'>
            Result
          </div>
          <JsonBlock data={d.result} />
        </div>
      ) : (
        <div className='text-xs text-gray-400'>No recorded result output.</div>
      )}

      <Collapsible title='Logs' hint='Grafana Loki · loads on open'>
        {() => {
          const grafanaService = createGrafanaService();
          const scopeId = d.scopeId || `${d.correlationId}-${d.jobName}`;
          return (
            <LogsViewer
              queryFn={() => grafanaService.queryJobLogs(scopeId, jobExecutionId, 15)}
              autoRefresh={d.status === 'running'}
              isJobRunning={d.status === 'running'}
              refreshInterval={5000}
            />
          );
        }}
      </Collapsible>
    </DrawerShell>
  );
};

export default JobDetailDrawer;
