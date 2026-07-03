// Shared node card for the flow canvas. One design rule: color states one fact,
// exactly once. Node KIND lives in the small tinted icon tile; run STATUS lives
// in the small semantic glyph (green check / red cross / blue spinner); the card
// itself stays neutral — white, hairline border, soft shadow. Selection is a
// crisp 2px colored line (border + adjacent 1px ring, so there is no gap between
// layers) with a slightly deeper shadow — no scale, no halo.

import React from 'react';

export type NodeTone = 'blue' | 'green' | 'purple' | 'amber' | 'gray';

const TILE: Record<NodeTone, string> = {
  blue: 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400',
  green: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
  purple: 'bg-violet-50 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400',
  amber: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
  gray: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
};

const SELECTED: Record<NodeTone, string> = {
  blue: 'border-blue-500 ring-1 ring-blue-500',
  green: 'border-emerald-500 ring-1 ring-emerald-500',
  purple: 'border-violet-500 ring-1 ring-violet-500',
  amber: 'border-amber-500 ring-1 ring-amber-500',
  gray: 'border-gray-400 ring-1 ring-gray-400',
};

export interface NodeShellProps {
  tone: NodeTone;
  icon: React.ReactNode;
  kindLabel: string;
  title: string;
  selected?: boolean;
  /** Subtle standing highlight for the invocation the user navigated here with. */
  focused?: boolean;
  /** Failed runs get a red hairline + faint wash — status color, applied quietly. */
  failed?: boolean;
  /** Ghost/expected nodes: dashed hairline, muted content. */
  dashed?: boolean;
  dimmed?: boolean;
  /** Small chips rendered after the kind label (ORIGIN, source, …). */
  badges?: React.ReactNode;
  /** Status glyph / extra affordances, right-aligned in the header row. */
  statusArea?: React.ReactNode;
  /** Quiet one-line metadata under the title. */
  meta?: React.ReactNode;
  /** Optional trailing line (e.g. "chains 2 invocations →"). */
  footer?: React.ReactNode;
  minWidthClass?: string;
  /** ReactFlow Handles + absolutely-positioned satellites (count badges). */
  children?: React.ReactNode;
}

export const NodeShell: React.FC<NodeShellProps> = ({
  tone,
  icon,
  kindLabel,
  title,
  selected,
  focused,
  failed,
  dashed,
  dimmed,
  badges,
  statusArea,
  meta,
  footer,
  minWidthClass = 'min-w-[200px]',
  children,
}) => {
  const border = selected
    ? SELECTED[tone]
    : failed
      ? 'border-red-300 dark:border-red-500/50'
      : focused
        ? 'border-blue-300 dark:border-blue-500/60'
        : 'border-gray-200 dark:border-gray-700';

  return (
    <div
      className={`
        relative rounded-lg border bg-white dark:bg-gray-800
        ${border} ${dashed ? 'border-dashed' : ''} ${dimmed ? 'opacity-60' : ''}
        ${failed && !selected ? 'bg-red-50/40 dark:bg-red-900/10' : ''}
        ${selected ? 'shadow-md' : 'shadow-sm hover:shadow-md hover:border-gray-300 dark:hover:border-gray-600'}
        transition-[box-shadow,border-color] duration-150 cursor-pointer ${minWidthClass}
      `}
    >
      <div className='flex items-start gap-2.5 p-3'>
        <div className={`flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center ${TILE[tone]}`}>{icon}</div>
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-1.5'>
            <span className='text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500'>
              {kindLabel}
            </span>
            {badges}
            {statusArea && <span className='ml-auto flex items-center gap-1 pl-2'>{statusArea}</span>}
          </div>
          <p className='mt-0.5 text-sm font-semibold text-gray-900 dark:text-white truncate' title={title}>
            {title}
          </p>
          {meta && <p className='mt-0.5 text-xs text-gray-500 dark:text-gray-400 tabular-nums truncate'>{meta}</p>}
          {footer && <p className='mt-0.5 text-[11px] text-gray-400 dark:text-gray-500'>{footer}</p>}
        </div>
      </div>
      {children}
    </div>
  );
};

/** Small neutral chip (ORIGIN, VIEWING, ghost states). Tinted just enough to read. */
export const NodeBadge: React.FC<{ tone?: 'blue' | 'gray' | 'amber'; title?: string; children: React.ReactNode }> = ({
  tone = 'gray',
  title,
  children,
}) => {
  const styles = {
    blue: 'bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-500/30',
    gray: 'bg-gray-50 text-gray-600 ring-gray-200 dark:bg-gray-700/60 dark:text-gray-300 dark:ring-gray-600',
    amber: 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  }[tone];
  return (
    <span className={`px-1 py-px rounded text-[9px] font-semibold tracking-wider ring-1 ring-inset ${styles}`} title={title}>
      {children}
    </span>
  );
};

/** Neutral satellite count badge next to a node's outgoing connector. */
export const CountBadge: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span className='inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-700 shadow-sm whitespace-nowrap'>
    {children}
  </span>
);

/** Semantic status glyphs — the ONLY place run status gets color. */
export const StatusGlyph: React.FC<{ status?: string; title?: string }> = ({ status, title }) => {
  if (status === 'failed') {
    return (
      <svg className='w-3.5 h-3.5 text-red-500' fill='currentColor' viewBox='0 0 20 20' aria-label='failed'>
        <title>{title ?? 'failed'}</title>
        <path
          fillRule='evenodd'
          d='M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z'
          clipRule='evenodd'
        />
      </svg>
    );
  }
  if (status === 'running') {
    return (
      <svg className='w-3.5 h-3.5 text-blue-500 animate-spin' fill='none' viewBox='0 0 24 24' aria-label='running'>
        <title>{title ?? 'running'}</title>
        <circle className='opacity-25' cx='12' cy='12' r='10' stroke='currentColor' strokeWidth='4' />
        <path className='opacity-75' fill='currentColor' d='M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z' />
      </svg>
    );
  }
  return (
    <svg className='w-3.5 h-3.5 text-emerald-500' fill='currentColor' viewBox='0 0 20 20' aria-label='ok'>
      <title>{title ?? 'completed'}</title>
      <path
        fillRule='evenodd'
        d='M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z'
        clipRule='evenodd'
      />
    </svg>
  );
};

export default NodeShell;
