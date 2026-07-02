// Invocation detail drawer — glance-first, zero tabs (drawer/primitives.tsx).
// Replaces the six-tab layout: everything an operator needs to understand "what
// happened" is in one prioritized scroll — error first, then the source record
// (with a changed-fields diff for UPDATEs), then events (click → event drawer),
// failed jobs surfaced early, raw payload collapsed at the bottom.

import React, { useMemo } from 'react';
import { Node } from 'reactflow';
import { useInvocationDetailQuery } from '../types/generated';
import { DrawerShell, StatusChip, Fact, FactGrid, ErrorPanel, Collapsible, JsonBlock, NodeRow } from './drawer/primitives';
import { formatDuration } from '../utils/formatDuration';
import { formatRelativeTime } from '../utils/formatTime';

interface InvocationDetailDrawerProps {
  node: Node | null;
  isOpen: boolean;
  onClose: () => void;
  /** Swap the drawer to another canvas node (cross-navigation; absent on the table page). */
  onOpenNodeId?: (nodeId: string) => void;
  /** Return to the previously-viewed node (present when a navigation trail exists). */
  onBack?: () => void;
}

/** Shallow changed-fields diff of a Hasura UPDATE payload — the question an operator
 *  actually asks ("what changed on the row?") without wading through raw JSON. */
function changedFields(oldRow: Record<string, unknown> | null, newRow: Record<string, unknown> | null) {
  if (!oldRow || !newRow) return [];
  const keys = new Set([...Object.keys(oldRow), ...Object.keys(newRow)]);
  const out: Array<{ key: string; from: unknown; to: unknown }> = [];
  for (const k of keys) {
    const a = oldRow[k];
    const b = newRow[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ key: k, from: a, to: b });
  }
  return out;
}

const short = (v: unknown): string => {
  if (v === null || v === undefined) return '∅';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 48 ? `${s.slice(0, 45)}…` : s;
};

const InvocationDetailDrawer: React.FC<InvocationDetailDrawerProps> = ({ node, isOpen, onClose, onOpenNodeId, onBack }) => {
  const { data, loading, error } = useInvocationDetailQuery({
    variables: { id: node?.id || '' },
    skip: !node?.id || !isOpen,
  });

  const inv = data?.invocations_by_pk;
  const payload: any = inv?.source_event_payload;
  const oldRow = payload?.event?.data?.old ?? null;
  const newRow = payload?.event?.data?.new ?? null;
  const diff = useMemo(() => changedFields(oldRow, newRow), [oldRow, newRow]);

  if (!isOpen || !node) return null;

  const detected = (inv?.event_executions ?? []).filter(e => e.detected);
  const undetectedCount = (inv?.event_executions ?? []).length - detected.length;
  const failedJobs = (inv?.event_executions ?? []).flatMap(e =>
    (e.job_executions ?? []).filter(j => j.status === 'failed').map(j => ({ ...j, eventName: e.event_name }))
  );
  const recordId = newRow?.id ?? oldRow?.id;
  const table = inv?.source_table?.split('.').pop();

  return (
    <DrawerShell
      kindLabel='Invocation'
      kindClass='text-blue-600 dark:text-blue-400'
      title={inv?.source_function ?? node.data?.sourceFunction ?? 'invocation'}
      statusChip={<StatusChip status={inv?.status ?? node.data?.status} />}
      factStrip={
        inv && (
          <span>
            {formatDuration(inv.total_duration_ms ?? 0)} ·{' '}
            <span title={new Date(inv.created_at).toLocaleString()}>{formatRelativeTime(inv.created_at)}</span>
            {inv.source_operation && ` · ${inv.source_operation}`}
            {table && recordId != null && ` · ${table}:${recordId}`}
          </span>
        )
      }
      correlationId={inv?.correlation_id ?? node.data?.correlationId}
      onClose={onClose}
      onBack={onBack}
    >
      {loading && <div className='text-sm text-gray-500'>Loading invocation…</div>}
      {error && <div className='text-sm text-red-500'>Failed to load: {error.message}</div>}

      {inv && (
        <>
          <ErrorPanel message={inv.error_message} stack={inv.error_stack} />

          <FactGrid>
            <Fact label='Record' mono>
              {table && recordId != null ? `${table}:${recordId}` : table ?? '—'}
            </Fact>
            <Fact label='Operation'>{inv.source_operation ?? '—'}</Fact>
            <Fact label='User'>{inv.source_user_email ?? '—'}</Fact>
            <Fact label='Role'>{inv.source_user_role ?? '—'}</Fact>
            <Fact label='Events'>
              {detected.length} detected · {undetectedCount} not
            </Fact>
            <Fact label='Jobs'>
              {inv.total_jobs_succeeded ?? 0}/{inv.total_jobs_run ?? 0} ok
              {inv.total_jobs_failed ? ` · ${inv.total_jobs_failed} failed` : ''}
            </Fact>
          </FactGrid>

          {failedJobs.length > 0 && (
            <div className='space-y-1.5'>
              <div className='text-xs font-semibold text-red-600 dark:text-red-400 uppercase tracking-wide'>
                Failed jobs ({failedJobs.length})
              </div>
              {failedJobs.map(j => (
                <NodeRow
                  key={j.id}
                  label={j.job_name}
                  sub={`${j.eventName} · ${j.error_message ? short(j.error_message) : formatDuration(j.duration_ms ?? 0)}`}
                  status='failed'
                  onClick={onOpenNodeId ? () => onOpenNodeId(`job-${j.id}`) : undefined}
                />
              ))}
            </div>
          )}

          {diff.length > 0 && (
            <div>
              <div className='text-xs font-semibold text-gray-700 dark:text-gray-200 uppercase tracking-wide mb-1.5'>
                Row changes ({diff.length} field{diff.length === 1 ? '' : 's'})
              </div>
              <div className='rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700 overflow-hidden'>
                {diff.map(({ key, from, to }) => (
                  <div key={key} className='px-3 py-1.5 grid grid-cols-[minmax(90px,30%)_1fr] gap-2 text-xs'>
                    <span className='font-mono text-gray-500 dark:text-gray-400 truncate' title={key}>
                      {key}
                    </span>
                    <span className='font-mono break-words'>
                      <span className='text-red-600 dark:text-red-400 line-through decoration-red-300' title={String(from)}>
                        {short(from)}
                      </span>{' '}
                      <span className='text-gray-400'>→</span>{' '}
                      <span className='text-green-700 dark:text-green-400' title={String(to)}>
                        {short(to)}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className='space-y-1.5'>
            <div className='text-xs font-semibold text-gray-700 dark:text-gray-200 uppercase tracking-wide'>
              Detected events ({detected.length})
            </div>
            {detected.map(e => (
              <NodeRow
                key={e.id}
                label={e.event_name}
                sub={`${(e.job_executions ?? []).length} jobs · detection ${formatDuration(e.detection_duration_ms ?? 0)}`}
                status={(e.job_executions ?? []).some(j => j.status === 'failed') ? 'failed' : e.status}
                onClick={onOpenNodeId ? () => onOpenNodeId(`event-${e.id}`) : undefined}
              />
            ))}
            {detected.length === 0 && <div className='text-xs text-gray-400'>No events detected on this invocation.</div>}
            {undetectedCount > 0 && (
              <div className='text-[11px] text-gray-400'>
                {undetectedCount} detector{undetectedCount === 1 ? '' : 's'} ran and returned false — enable “Show
                undetected” on the canvas to see them.
              </div>
            )}
          </div>

          <Collapsible title='Source payload' hint={payload?.event?.op ?? ''}>
            {() => <JsonBlock data={payload} />}
          </Collapsible>
          {inv.context_data != null && (
            <Collapsible title='Context data'>{() => <JsonBlock data={inv.context_data} />}</Collapsible>
          )}
        </>
      )}
    </DrawerShell>
  );
};

export default InvocationDetailDrawer;
