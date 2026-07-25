import React, { useState } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { CursorArrowRaysIcon } from '@heroicons/react/24/outline';
import { NodeShell, NodeBadge } from './NodeShell';
import { useOriginUser } from '../../hooks/useOriginUser';
import { formatRelativeTime } from '../../utils/formatTime';

// The synthetic "origin" node the layout injects to the LEFT of a chain root when the
// origin-decoder plugin persisted a decoded client origin into context_data.origin. It
// says WHERE a chain came from: the frontend action a user took, plus who triggered the
// root and when. The node TYPE is `userAction` on purpose: the InvocationNode already
// owns an ORIGIN badge (that marks the chain root itself), and this is a different thing
// (the surface/action that started it). The decoded origin is consumer-shaped and
// spoofable, so everything here is display only and must never crash on odd input.

export interface UserActionNodeData {
  /** Decoded origin: an arbitrary consumer object, or a raw string, never trusted. */
  origin: Record<string, unknown> | string;
  userEmail?: string | null;
  userRole?: string | null;
  eventTime?: string | null;
  /** Stamped by the canvas: when present, this node (not the root invocation) is the chain's origin. */
  isOrigin?: boolean;
  /** Display-only click grouping: the client-supplied clickId this action fanned from. */
  clickId?: string | null;
  /** Chain roots this one click started (>1 when the click fanned into several chains). */
  rootInvocationIds?: string[];
}

/** Render any value on one short line without throwing (objects → compact JSON). */
function displayValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatWhen(eventTime?: string | null): string | null {
  if (!eventTime) return null;
  const d = new Date(eventTime);
  return Number.isNaN(d.getTime()) ? eventTime : d.toLocaleString();
}

/** First letters of up to two name words (or the email's local part). */
function initialsOf(name?: string | null, email?: string | null): string {
  const source = (name || email?.split('@')[0] || '').trim();
  if (!source) return '?';
  const words = source.split(/[\s._-]+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase();
}

/** Small neutral avatar: the resolved image when it loads, initials otherwise. */
export const OriginAvatar: React.FC<{
  avatarUrl?: string | null;
  displayName?: string | null;
  email?: string | null;
  sizeClass?: string;
}> = ({ avatarUrl, displayName, email, sizeClass = 'w-6 h-6' }) => {
  const [imgFailed, setImgFailed] = useState(false);
  if (avatarUrl && !imgFailed) {
    return (
      <img
        src={avatarUrl}
        alt={displayName || email || 'user'}
        className={`${sizeClass} rounded-full object-cover shrink-0 bg-gray-100 dark:bg-gray-700`}
        onError={() => setImgFailed(true)}
      />
    );
  }
  return (
    <span
      className={`${sizeClass} rounded-full shrink-0 flex items-center justify-center bg-gray-100 dark:bg-gray-700 text-[9px] font-semibold text-gray-500 dark:text-gray-300`}
    >
      {initialsOf(displayName, email)}
    </span>
  );
};

export const UserActionNode: React.FC<NodeProps<UserActionNodeData>> = ({ data, selected }) => {
  const { origin, userEmail, eventTime, isOrigin, rootInvocationIds } = data;
  const chainCount = rootInvocationIds?.length ?? 1;

  // A raw-string origin: show it verbatim, no key/value breakdown.
  const isObject = origin != null && typeof origin === 'object';
  const obj = isObject ? (origin as Record<string, unknown>) : {};

  const action = isObject ? displayValue(obj.action) : '';
  const site = isObject ? displayValue(obj.site) : '';

  const title = action || site || (typeof origin === 'string' ? origin : 'Client origin');

  const profile = useOriginUser(userEmail);
  const whoName = profile?.displayName || userEmail || null;
  const when = formatWhen(eventTime);

  // Glance-first, same visual weight as the other nodes: WHAT (the action slug,
  // which already carries the site prefix) and WHO/WHEN (avatar · name · relative
  // time) — one slim row. Purpose, action id, role, and any extra decoded keys
  // live in the detail drawer, not on the canvas.
  return (
    <NodeShell
      tone='amber'
      icon={<CursorArrowRaysIcon className='w-4 h-4' />}
      kindLabel='User action'
      title={title}
      selected={selected}
      badges={
        <>
          {isOrigin && (
            <NodeBadge tone='amber' title='This user action started the chain'>ORIGIN</NodeBadge>
          )}
          {chainCount > 1 && (
            <NodeBadge tone='gray' title={`This one click started ${chainCount} chains (grouped by client clickId)`}>
              {chainCount} chains
            </NodeBadge>
          )}
        </>
      }
      minWidthClass='w-[240px]'
    >
      <Handle type='source' position={Position.Right} id='right' className='w-3 h-3' />

      {(whoName || when) && (
        <div
          className='border-t border-gray-100 dark:border-gray-700/60 px-3 py-1.5 flex items-center gap-2 min-w-0'
          title={when ?? undefined}
        >
          <OriginAvatar
            avatarUrl={profile?.avatarUrl}
            displayName={profile?.displayName}
            email={userEmail}
            sizeClass='w-[18px] h-[18px]'
          />
          <p className='min-w-0 flex-1 text-[11px] text-gray-500 dark:text-gray-400 truncate'>
            {whoName && <span className='text-gray-700 dark:text-gray-200'>{whoName}</span>}
            {whoName && when && ' · '}
            {when && <span className='tabular-nums'>{formatRelativeTime(eventTime!)}</span>}
          </p>
        </div>
      )}
    </NodeShell>
  );
};

export default UserActionNode;
