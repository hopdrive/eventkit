// Event detail drawer — glance-first, zero tabs (drawer/primitives.tsx). The
// primary content is the event's JOBS: each row shows name/status/duration and one
// click swaps the drawer to that job (cross-navigation instead of tab-hopping).

import React from 'react';
import { Node } from 'reactflow';
import { DrawerShell, StatusChip, Fact, FactGrid, NodeRow } from './drawer/primitives';
import { formatDuration } from '../utils/formatDuration';
import { formatRelativeTime } from '../utils/formatTime';

interface EventDetailDrawerProps {
  node: Node | null;
  isOpen: boolean;
  onClose: () => void;
  /** Job nodes on the canvas that belong to this event (edges event -> job). */
  relatedJobs?: Node[];
  /** Swap the drawer to another canvas node (cross-navigation). */
  onOpenNodeId?: (nodeId: string) => void;
}

const EventDetailDrawer: React.FC<EventDetailDrawerProps> = ({ node, isOpen, onClose, relatedJobs = [], onOpenNodeId }) => {
  if (!isOpen || !node || node.type !== 'event') return null;
  const d = node.data ?? {};
  const started = d.createdAt ? new Date(d.createdAt) : undefined;

  return (
    <DrawerShell
      kindLabel='Event'
      kindClass='text-green-600 dark:text-green-400'
      title={d.eventName ?? 'event'}
      statusChip={<StatusChip status={d.ghost ? 'not_detected' : d.detected ? (d.hasFailedJobs ? 'failed' : 'detected') : 'not_detected'} />}
      factStrip={
        <span>
          detection {formatDuration(d.detectionDuration ?? 0)}
          {d.handlerDuration != null && ` · handler ${formatDuration(d.handlerDuration)}`}
          {started && (
            <>
              {' · '}
              <span title={started.toLocaleString()}>{formatRelativeTime(d.createdAt)}</span>
            </>
          )}
        </span>
      }
      correlationId={d.correlationId}
      onClose={onClose}
    >
      {d.ghost && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            d.ghostTone === 'warning'
              ? 'border-amber-300 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300'
              : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 text-gray-600 dark:text-gray-300'
          }`}
        >
          {d.ghostTone === 'warning' ? (
            <>
              <span className='font-semibold'>Never ran.</span> Every registered detector evaluates on every
              invocation, so a flow-doc event with no record means the deployed code and the doc disagree: a stale
              committed doc, code not yet deployed, the wrong doc selected for this function, or a lost observability
              write. Treat it as a defect to chase, not noise.
            </>
          ) : (
            <>The detector ran and returned false — this event did not occur for this payload. Normal operation.</>
          )}
        </div>
      )}

      <FactGrid>
        <Fact label='Detected'>{d.ghost ? '—' : d.detected ? 'yes' : 'no'}</Fact>
        <Fact label='Jobs run'>{d.jobsCount ?? relatedJobs.length}</Fact>
        <Fact label='Detection time'>{formatDuration(d.detectionDuration ?? 0)}</Fact>
        <Fact label='Started'>{started ? started.toLocaleString() : '—'}</Fact>
      </FactGrid>

      {relatedJobs.length > 0 && (
        <div className='space-y-1.5'>
          <div className='text-xs font-semibold text-gray-700 dark:text-gray-200 uppercase tracking-wide'>
            Jobs ({relatedJobs.length})
          </div>
          {relatedJobs.map(j => (
            <NodeRow
              key={j.id}
              label={j.data?.jobName ?? j.id}
              sub={formatDuration(j.data?.duration ?? 0)}
              status={j.data?.ghost ? 'not_detected' : j.data?.status}
              onClick={onOpenNodeId ? () => onOpenNodeId(j.id) : undefined}
            />
          ))}
        </div>
      )}
      {relatedJobs.length === 0 && !d.ghost && (
        <div className='text-xs text-gray-400'>No job executions recorded for this event.</div>
      )}
    </DrawerShell>
  );
};

export default EventDetailDrawer;
