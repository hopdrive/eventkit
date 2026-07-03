// Shared drawer grammar for node detail panels (design decisions, applied to all
// three drawers):
//   1. ZERO tabs — one scrollable column; nothing important is a click away.
//   2. Glance header — kind + status + name + duration/time + copyable correlation
//      id, always visible (sticky) while scrolling.
//   3. Failure-first — if it failed, the error (message + expandable stack) is the
//      first section, not a tab.
//   4. Raw JSON is in-flow but collapsed (one disclosure, not a mode switch), and
//      heavy content (logs) mounts only when opened.
//   5. Cross-navigation — rows for child/parent nodes swap the drawer in place via
//      onOpenNodeId, so walking event → job → triggered invocation is one click each.

import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { XMarkIcon, ClipboardIcon, CheckIcon, ChevronRightIcon, ArrowLeftIcon } from '@heroicons/react/24/outline';
import ReactJson from '@microlink/react-json-view';

// react-json-view base16 theme on the tailwind gray-800 panel. Key slots
// (per the library's mapping): base07 object keys, base09 strings, base0B
// floats, base0E booleans, base0F integers, base0A null, base0D expand icon.
export const jsonViewTheme = {
  base00: 'transparent', // panel bg comes from the container
  base01: '#374151',
  base02: '#4b5563', // indent guides
  base03: '#6b7280',
  base04: '#9ca3af', // item counts
  base05: '#d1d5db', // brackets/default
  base06: '#e5e7eb',
  base07: '#93c5fd', // object keys — blue-300
  base08: '#f87171',
  base09: '#4ade80', // strings — green-400
  base0A: '#f87171', // null/regexp — red-400
  base0B: '#fb923c', // floats — orange-400
  base0C: '#22d3ee',
  base0D: '#9ca3af', // expand/collapse icons
  base0E: '#c084fc', // booleans — purple-400
  base0F: '#fb923c', // integers — orange-400
};

export const StatusChip: React.FC<{ status?: string | null }> = ({ status }) => {
  const s = status || 'unknown';
  const styles: Record<string, string> = {
    completed: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 animate-pulse',
    detected: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
    not_detected: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles[s] ?? styles.not_detected}`}>
      {s.replace(/_/g, ' ')}
    </span>
  );
};

export const CopyButton: React.FC<{ value: string; title?: string }> = ({ value, title }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={e => {
        e.stopPropagation();
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className='p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors flex-shrink-0'
      title={title ?? 'Copy'}
    >
      {copied ? <CheckIcon className='h-3.5 w-3.5 text-green-500' /> : <ClipboardIcon className='h-3.5 w-3.5' />}
    </button>
  );
};

export const Fact: React.FC<{ label: string; children: React.ReactNode; mono?: boolean; span2?: boolean }> = ({
  label,
  children,
  mono,
  span2,
}) => (
  <div className={span2 ? 'col-span-2' : ''}>
    <dt className='text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide'>{label}</dt>
    <dd className={`mt-0.5 text-sm text-gray-900 dark:text-gray-100 break-words ${mono ? 'font-mono text-xs' : ''}`}>
      {children}
    </dd>
  </div>
);

export const FactGrid: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <dl className='grid grid-cols-2 gap-x-4 gap-y-3'>{children}</dl>
);

export const ErrorPanel: React.FC<{ message?: string | null; stack?: string | null }> = ({ message, stack }) => {
  const [showStack, setShowStack] = useState(false);
  if (!message && !stack) return null;
  return (
    <div className='rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3'>
      <div className='text-xs font-semibold text-red-700 dark:text-red-400 uppercase tracking-wide mb-1'>Error</div>
      <div className='text-sm text-red-800 dark:text-red-300 font-mono whitespace-pre-wrap break-words'>
        {message ?? 'unknown error'}
      </div>
      {stack && (
        <button
          onClick={() => setShowStack(v => !v)}
          className='mt-2 text-xs text-red-600 dark:text-red-400 underline underline-offset-2'
        >
          {showStack ? 'hide stack' : 'show stack'}
        </button>
      )}
      {showStack && stack && (
        <pre className='mt-2 text-[11px] text-red-700 dark:text-red-300 whitespace-pre-wrap break-words max-h-64 overflow-auto'>
          {stack}
        </pre>
      )}
    </div>
  );
};

export const Collapsible: React.FC<{
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: React.ReactNode | (() => React.ReactNode); // function = lazy mount (logs)
}> = ({ title, hint, defaultOpen = false, children }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className='border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden'>
      <button
        onClick={() => setOpen(v => !v)}
        className='w-full flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-900/40 hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors'
      >
        <span className='text-xs font-semibold text-gray-700 dark:text-gray-200 uppercase tracking-wide'>{title}</span>
        <span className='flex items-center gap-2'>
          {hint && <span className='text-[11px] text-gray-400'>{hint}</span>}
          <ChevronRightIcon className={`h-3.5 w-3.5 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        </span>
      </button>
      {open && <div className='p-3'>{typeof children === 'function' ? children() : children}</div>}
    </div>
  );
};

export const JsonBlock: React.FC<{ data: unknown; collapsed?: number }> = ({ data, collapsed = 2 }) => (
  <div className='rounded-lg bg-gray-800 p-2.5 overflow-auto max-h-96'>
    <ReactJson
      src={(typeof data === 'object' && data !== null ? data : { value: data }) as object}
      theme={jsonViewTheme}
      collapsed={collapsed}
      name={false}
      displayDataTypes={false}
      displayObjectSize={true}
      enableClipboard={true}
      quotesOnKeys={false}
      indentWidth={2}
      style={{ backgroundColor: 'transparent', fontSize: '12px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
    />
  </div>
);

export const SectionTitle: React.FC<{ children: React.ReactNode; right?: React.ReactNode }> = ({ children, right }) => (
  <div className='flex items-center justify-between'>
    <h4 className='text-xs font-semibold text-gray-700 dark:text-gray-200 uppercase tracking-wide'>{children}</h4>
    {right}
  </div>
);

/** A clickable child-node row (event's job, invocation's event, …) — one click to swap the drawer. */
export const NodeRow: React.FC<{
  label: string;
  sub?: string;
  status?: string | null;
  onClick?: () => void;
}> = ({ label, sub, status, onClick }) => (
  <button
    onClick={onClick}
    disabled={!onClick}
    className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 text-left ${
      onClick ? 'hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer' : 'cursor-default'
    }`}
  >
    <div className='min-w-0'>
      <div className='text-sm font-medium text-gray-900 dark:text-gray-100 truncate'>{label}</div>
      {sub && <div className='text-[11px] text-gray-500 dark:text-gray-400'>{sub}</div>}
    </div>
    <div className='flex items-center gap-2 flex-shrink-0'>
      <StatusChip status={status} />
      {onClick && <ChevronRightIcon className='h-3.5 w-3.5 text-gray-400' />}
    </div>
  </button>
);

export interface DrawerShellProps {
  kindLabel: string;
  kindClass: string; // text color class for the kind label
  title: string;
  statusChip?: React.ReactNode;
  factStrip?: React.ReactNode; // duration · time strip under the title
  correlationId?: string | null;
  onClose: () => void;
  /** Present when cross-navigation built a trail — renders a back button that returns to the prior node. */
  onBack?: () => void;
  children: React.ReactNode;
}

export const DrawerShell: React.FC<DrawerShellProps> = ({
  kindLabel,
  kindClass,
  title,
  statusChip,
  factStrip,
  correlationId,
  onClose,
  onBack,
  children,
}) => (
  <motion.div
    initial={{ x: '100%' }}
    animate={{ x: 0 }}
    exit={{ x: '100%' }}
    transition={{ type: 'tween', duration: 0.18 }}
    className='fixed right-0 top-0 h-full w-[600px] max-w-full bg-white dark:bg-gray-800 shadow-2xl border-l border-gray-200 dark:border-gray-700 z-50 flex flex-col'
  >
    <div className='px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-white/95 dark:bg-gray-800/95'>
      <div className='flex items-start justify-between gap-2'>
        {onBack && (
          <button
            onClick={onBack}
            className='mt-0.5 p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors flex-shrink-0'
            title='Back to previous node'
          >
            <ArrowLeftIcon className='h-4 w-4' />
          </button>
        )}
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-2'>
            <span className={`text-xs font-semibold uppercase tracking-wide ${kindClass}`}>{kindLabel}</span>
            {statusChip}
          </div>
          <h3 className='mt-0.5 text-base font-semibold text-gray-900 dark:text-white truncate' title={title}>
            {title}
          </h3>
          {factStrip && <div className='mt-0.5 text-xs text-gray-500 dark:text-gray-400'>{factStrip}</div>}
        </div>
        <button
          onClick={onClose}
          className='p-1.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors flex-shrink-0'
        >
          <XMarkIcon className='h-5 w-5' />
        </button>
      </div>
      {correlationId && (
        <div className='mt-1.5 flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400 font-mono'>
          <span className='truncate' title={correlationId}>
            {correlationId}
          </span>
          <CopyButton value={correlationId} title='Copy correlation id' />
        </div>
      )}
    </div>
    <div className='flex-1 overflow-y-auto p-4 space-y-4'>{children}</div>
  </motion.div>
);
