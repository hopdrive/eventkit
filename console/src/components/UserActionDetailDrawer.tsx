// User-action detail drawer — the click-through for the synthetic origin node.
// Everything here is the decoded client origin (consumer-shaped, spoofable) plus
// the root invocation's who/when, so the drawer presents it as context, not as
// authenticated fact, and never crashes on odd input.

import React from 'react';
import { Node } from 'reactflow';
import { DrawerShell, Fact, FactGrid, Collapsible, JsonBlock, SectionTitle, NodeRow } from './drawer/primitives';
import { OriginAvatar } from './nodes/UserActionNode';
import { useOriginUser } from '../hooks/useOriginUser';
import { formatRelativeTime } from '../utils/formatTime';
import { originKindLabel } from '../utils/originKind';

interface UserActionDetailDrawerProps {
  node: Node | null;
  isOpen: boolean;
  onClose: () => void;
  /** Swap the drawer to another canvas node (cross-navigation). */
  onOpenNodeId?: (nodeId: string) => void;
  onBack?: () => void;
}

// Keys already rendered as first-class facts; everything else lands under
// "Additional context". `id` is the Action id fact; `trigger` is the kind + Trigger fact.
const CONVENTIONAL = ['action', 'site', 'purpose', 'id', 'trigger'] as const;

function asDisplay(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const UserActionDetailDrawer: React.FC<UserActionDetailDrawerProps> = ({
  node,
  isOpen,
  onClose,
  onOpenNodeId,
  onBack,
}) => {
  const data = node?.data ?? {};
  const profile = useOriginUser(data.userEmail);
  if (!isOpen || !node || node.type !== 'userAction') return null;

  const { origin, userEmail, userRole, eventTime } = data;
  const isObject = origin != null && typeof origin === 'object' && !Array.isArray(origin);
  const obj = isObject ? (origin as Record<string, unknown>) : {};

  const action = asDisplay(obj.action);
  const site = asDisplay(obj.site);
  const purpose = asDisplay(obj.purpose);
  const trigger = asDisplay(obj.trigger);
  const title = action || site || (typeof origin === 'string' ? origin : 'Client origin');
  // Kind header derived from the decoded `trigger` (user / webhook / schedule / system);
  // a decoded origin is any registered entry point, not only a human click.
  const kindLabel = originKindLabel(origin);

  const rest = isObject
    ? Object.entries(obj).filter(([k, v]) => !CONVENTIONAL.includes(k as (typeof CONVENTIONAL)[number]) && v != null)
    : [];

  const when = eventTime ? new Date(eventTime) : null;
  const whenValid = when && !Number.isNaN(when.getTime());
  const name = profile?.displayName || userEmail || null;

  // Chain roots this one click started. `roots` is stamped by the layout (one entry, or
  // several when a click fanned into multiple chains). Fall back to the id convention
  // `origin-<rootInvocationId>` for any older node without the field.
  const roots: Array<{ id: string; sourceFunction?: string; correlationId?: string }> = Array.isArray(data.roots)
    ? (data.roots as Array<{ id: string; sourceFunction?: string; correlationId?: string }>)
    : node.id.startsWith('origin-') && !node.id.startsWith('origin-click-')
      ? [{ id: node.id.slice('origin-'.length) }]
      : [];
  const clickId = typeof data.clickId === 'string' ? data.clickId : null;
  const shortCorr = (correlationId?: string) => correlationId?.split('.').pop()?.slice(0, 8);

  return (
    <DrawerShell
      kindLabel={kindLabel}
      kindClass='text-amber-600 dark:text-amber-400'
      title={title}
      factStrip={
        <span>
          {site || kindLabel}
          {eventTime && (
            <>
              {' · '}
              <span title={whenValid ? when!.toLocaleString() : undefined}>{formatRelativeTime(eventTime)}</span>
            </>
          )}
        </span>
      }
      onClose={onClose}
      onBack={onBack}
    >
      {/* Who: resolved profile when the host wrapper injected a userResolver,
          initials + raw email otherwise. */}
      {(name || userRole) && (
        <div className='flex items-center gap-3 px-3 py-2.5 rounded-lg border border-gray-200 dark:border-gray-700'>
          <OriginAvatar
            avatarUrl={profile?.avatarUrl}
            displayName={profile?.displayName}
            email={userEmail}
            sizeClass='w-10 h-10'
          />
          <div className='min-w-0'>
            <p className='text-sm font-medium text-gray-900 dark:text-gray-100 truncate'>{name || 'Unknown user'}</p>
            <p className='text-[11px] text-gray-500 dark:text-gray-400 truncate'>
              {[profile?.displayName ? userEmail : null, userRole].filter(Boolean).join(' · ') || '—'}
            </p>
          </div>
        </div>
      )}

      <FactGrid>
        {trigger && <Fact label='Trigger'>{trigger}</Fact>}
        <Fact label='Site'>{site || '—'}</Fact>
        <Fact label='Role'>{userRole || '—'}</Fact>
        <Fact label='When'>{whenValid ? when!.toLocaleString() : eventTime || '—'}</Fact>
        <Fact label='Action id' mono span2>
          {asDisplay(obj.id) || '—'}
        </Fact>
      </FactGrid>

      {purpose && <p className='text-sm text-gray-600 dark:text-gray-300 break-words'>{purpose}</p>}

      {typeof origin === 'string' && <p className='text-sm text-gray-600 dark:text-gray-300 break-words'>{origin}</p>}

      {rest.length > 0 && (
        <div className='space-y-1.5'>
          <SectionTitle>Additional context</SectionTitle>
          {rest.map(([k, v]) => (
            <div key={k} className='flex items-baseline gap-3 text-xs'>
              <span className='w-28 flex-shrink-0 text-gray-400 dark:text-gray-500'>{k}</span>
              <span className='min-w-0 text-gray-700 dark:text-gray-200 break-words'>{asDisplay(v)}</span>
            </div>
          ))}
        </div>
      )}

      {isObject && <Collapsible title='Decoded origin (raw)'>{() => <JsonBlock data={origin} />}</Collapsible>}

      {roots.length > 0 && onOpenNodeId && (
        <div className='space-y-1.5'>
          <SectionTitle>{roots.length > 1 ? `This click started ${roots.length} chains` : 'Started'}</SectionTitle>
          {roots.map(r => (
            <NodeRow
              key={r.id}
              label={r.sourceFunction || 'Chain root invocation'}
              sub={shortCorr(r.correlationId) || r.id}
              onClick={() => onOpenNodeId(r.id)}
            />
          ))}
          {roots.length > 1 && (
            <p className='text-[11px] text-gray-400 dark:text-gray-500'>
              Grouped by the client-supplied clickId{clickId ? ` (${clickId})` : ''}. Display only: these are separate
              chains that one click started, each keeping its own correlation id.
            </p>
          )}
        </div>
      )}

      <p className='text-[11px] text-gray-400 dark:text-gray-500'>
        Client-supplied context, decoded from the registered action id. Display only: the user identity above comes
        from the signed session, but the action details are whatever the client sent.
      </p>
    </DrawerShell>
  );
};

export default UserActionDetailDrawer;
