import React, { useState } from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { CursorArrowRaysIcon } from '@heroicons/react/24/outline';
import { NodeShell, NodeBadge } from './NodeShell';
import { useOriginUser } from '../../hooks/useOriginUser';

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
}

/** Keys the console renders prominently when a decoder happens to use them. */
const CONVENTIONAL = ['action', 'site', 'purpose'] as const;

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
  const { origin, userEmail, userRole, eventTime, isOrigin } = data;

  // A raw-string origin: show it verbatim, no key/value breakdown.
  const isObject = origin != null && typeof origin === 'object';
  const obj = isObject ? (origin as Record<string, unknown>) : {};

  const action = isObject ? displayValue(obj.action) : '';
  const site = isObject ? displayValue(obj.site) : '';
  const purpose = isObject ? displayValue(obj.purpose) : '';

  const title = action || site || (typeof origin === 'string' ? origin : 'Client origin');
  // Only the short site label rides the one-line meta slot; the purpose sentence
  // wraps in the body instead, so it can never stretch the card sideways.
  const metaLine = site || undefined;

  // Everything the decoder returned that isn't one of the conventional keys.
  const rest = isObject
    ? Object.entries(obj).filter(([k, v]) => !CONVENTIONAL.includes(k as (typeof CONVENTIONAL)[number]) && v != null)
    : [];

  const profile = useOriginUser(userEmail);
  const whoName = profile?.displayName || userEmail || null;
  const who = [whoName, userRole].filter(Boolean).join(' · ');
  const when = formatWhen(eventTime);

  return (
    <NodeShell
      tone='amber'
      icon={<CursorArrowRaysIcon className='w-4 h-4' />}
      kindLabel='User action'
      title={title}
      selected={selected}
      badges={isOrigin ? <NodeBadge tone='amber' title='This user action started the chain'>ORIGIN</NodeBadge> : undefined}
      meta={metaLine}
      minWidthClass='w-[300px]'
    >
      <Handle type='source' position={Position.Right} id='right' className='w-3 h-3' />

      {(typeof origin === 'string' && !isObject) || purpose || rest.length > 0 || who || when ? (
        <div className='border-t border-gray-100 dark:border-gray-700/60 px-3 py-2 space-y-1'>
          {typeof origin === 'string' && (
            <p className='text-xs text-gray-600 dark:text-gray-300 break-words line-clamp-3'>{origin}</p>
          )}
          {purpose && (
            <p className='text-xs text-gray-600 dark:text-gray-300 break-words line-clamp-3' title={purpose}>
              {purpose}
            </p>
          )}
          {rest.map(([k, v]) => (
            <div key={k} className='flex items-baseline gap-2 text-[11px] leading-tight'>
              <span className='text-gray-400 dark:text-gray-500 shrink-0'>{k}</span>
              <span className='text-gray-700 dark:text-gray-200 min-w-0 truncate' title={displayValue(v)}>
                {displayValue(v)}
              </span>
            </div>
          ))}
          {(who || when) && (
            <div className='pt-1 flex items-center gap-2 min-w-0'>
              <OriginAvatar avatarUrl={profile?.avatarUrl} displayName={profile?.displayName} email={userEmail} />
              <div className='min-w-0 leading-tight'>
                <p className='text-[11px] text-gray-700 dark:text-gray-200 truncate' title={who || undefined}>
                  {who || 'no user'}
                </p>
                {when && <p className='text-[10px] text-gray-400 dark:text-gray-500 tabular-nums truncate'>{when}</p>}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </NodeShell>
  );
};

export default UserActionNode;
