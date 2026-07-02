// Small source-identity chip shared by the invocation canvas node and drawer:
// an icon for the source CATEGORY (database/webhook/cron/…) plus the adapter's
// short name. Same visual grammar at both sizes so a user learns it once.

import React from 'react';
import {
  CircleStackIcon,
  BoltIcon,
  ClockIcon,
  CursorArrowRaysIcon,
  CubeIcon,
  QueueListIcon,
  HandRaisedIcon,
  QuestionMarkCircleIcon,
} from '@heroicons/react/24/outline';
import { SourceKind, resolveSourceKind, sourceSystemLabel } from '../utils/sourceKind';

const KIND_ICONS: Record<SourceKind, React.ComponentType<{ className?: string }>> = {
  database: CircleStackIcon,
  webhook: BoltIcon,
  cron: ClockIcon,
  action: CursorArrowRaysIcon,
  application: CubeIcon,
  queue: QueueListIcon,
  manual: HandRaisedIcon,
  unknown: QuestionMarkCircleIcon,
};

export const SourceChip: React.FC<{
  sourceType?: string | null;
  sourceSystem?: string | null;
  payload?: unknown;
  /** Compact = canvas node (tiny); default = drawer/table. */
  compact?: boolean;
}> = ({ sourceType, sourceSystem, payload, compact }) => {
  const kind = resolveSourceKind(sourceType, sourceSystem, payload);
  const label = sourceSystemLabel(sourceSystem) ?? kind;
  if (!sourceSystem && kind === 'unknown') return null;
  const Icon = KIND_ICONS[kind];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 font-medium ${
        compact ? 'px-1 py-px text-[9px]' : 'px-1.5 py-0.5 text-[11px]'
      }`}
      title={`Source: ${sourceSystem ?? 'unknown'} (${kind})`}
    >
      <Icon className={compact ? 'h-2.5 w-2.5' : 'h-3.5 w-3.5'} />
      {label}
    </span>
  );
};

export default SourceChip;
