import React from 'react';
import { Handle, Position, NodeProps } from 'reactflow';
import { CursorArrowRaysIcon } from '@heroicons/react/24/outline';
import { NodeShell } from './NodeShell';

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

export const UserActionNode: React.FC<NodeProps<UserActionNodeData>> = ({ data, selected }) => {
  const { origin, userEmail, userRole, eventTime } = data;

  // A raw-string origin: show it verbatim, no key/value breakdown.
  const isObject = origin != null && typeof origin === 'object';
  const obj = isObject ? (origin as Record<string, unknown>) : {};

  const action = isObject ? displayValue(obj.action) : '';
  const site = isObject ? displayValue(obj.site) : '';
  const purpose = isObject ? displayValue(obj.purpose) : '';

  const title = action || site || (typeof origin === 'string' ? origin : 'Client origin');
  const metaLine = [site, purpose].filter(Boolean).join(' · ') || undefined;

  // Everything the decoder returned that isn't one of the conventional keys.
  const rest = isObject
    ? Object.entries(obj).filter(([k, v]) => !CONVENTIONAL.includes(k as (typeof CONVENTIONAL)[number]) && v != null)
    : [];

  const who = [userEmail, userRole].filter(Boolean).join(' · ');
  const when = formatWhen(eventTime);

  return (
    <NodeShell
      tone='amber'
      icon={<CursorArrowRaysIcon className='w-4 h-4' />}
      kindLabel='User action'
      title={title}
      selected={selected}
      meta={metaLine}
      minWidthClass='min-w-[210px]'
    >
      <Handle type='source' position={Position.Right} id='right' className='w-3 h-3' />

      {(typeof origin === 'string' && !isObject) || rest.length > 0 || who || when ? (
        <div className='border-t border-gray-100 dark:border-gray-700/60 px-3 py-2 space-y-1'>
          {typeof origin === 'string' && (
            <p className='text-xs text-gray-600 dark:text-gray-300 break-words'>{origin}</p>
          )}
          {rest.map(([k, v]) => (
            <div key={k} className='flex items-baseline gap-2 text-[11px] leading-tight'>
              <span className='text-gray-400 dark:text-gray-500 shrink-0'>{k}</span>
              <span className='text-gray-700 dark:text-gray-200 truncate' title={displayValue(v)}>
                {displayValue(v)}
              </span>
            </div>
          ))}
          {(who || when) && (
            <p className='pt-1 text-[11px] text-gray-400 dark:text-gray-500 tabular-nums'>
              {who || 'no user'}
              {when ? ` · ${when}` : ''}
            </p>
          )}
        </div>
      ) : null}
    </NodeShell>
  );
};

export default UserActionNode;
