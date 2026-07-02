// prettier-ignore

import React, { useState, useMemo } from 'react';
import { AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  ColumnDef,
  SortingState,
  ColumnFiltersState,
  VisibilityState,
} from '@tanstack/react-table';
import {
  MagnifyingGlassIcon,
  AdjustmentsHorizontalIcon,
  ChevronUpDownIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExclamationTriangleIcon,
  CircleStackIcon,
} from '@heroicons/react/24/outline';
import InvocationDetailDrawer from './InvocationDetailDrawer';
import { useInvocationsListQuery } from '../types/generated';
import { Node } from 'reactflow';
import { formatRelativeTime } from '../utils/formatTime';

interface Invocation {
  id: string;
  sourceFunction: string;
  correlationId: string;
  userEmail: string;
  sourceOperation: string;
  sourceJobId?: string;
  totalDuration: number;
  eventsDetectedCount: number;
  detectedEventNames: string[];
  totalJobsSucceeded: number;
  totalJobsFailed: number;
  totalJobsRun: number;
  status: 'completed' | 'failed' | 'running';
  createdAt: string;
  recordId?: string;
}

const columnHelper = createColumnHelper<Invocation>();

interface InvocationsTableProps {
  correlationSearch?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sortable column id -> invocations order_by field (server-side sorting).
const ORDER_FIELDS: Record<string, string> = {
  sourceFunction: 'source_function',
  createdAt: 'created_at',
  totalDuration: 'total_duration_ms',
  status: 'status',
  userEmail: 'source_user_email',
};

const InvocationsTable: React.FC<InvocationsTableProps> = ({ correlationSearch = '' }) => {
  const navigate = useNavigate();
  const [selectedInvocation, setSelectedInvocation] = useState<Node | null>(null);
  const [hideZeroDetectedEvents, setHideZeroDetectedEvents] = useState(true);
  const [hideChildInvocations, setHideChildInvocations] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });

  // Header correlation-search drives the same server-side search.
  React.useEffect(() => {
    setSearchText(correlationSearch);
  }, [correlationSearch]);

  // Debounce the search input (perf fix P3): one server query per pause, not per keystroke.
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchText.trim()), 250);
    return () => clearTimeout(t);
  }, [searchText]);

  // Back to page 1 whenever the result-set definition changes.
  React.useEffect(() => {
    setPagination(p => (p.pageIndex === 0 ? p : { ...p, pageIndex: 0 }));
  }, [debouncedSearch, statusFilter, hideZeroDetectedEvents, hideChildInvocations]);

  // Server-side where clause (perf fix P1/P5): filters and search run in Postgres over
  // the WHOLE dataset on indexed columns — not over a 1,000-row client window.
  const where = useMemo(() => {
    const and: Record<string, unknown>[] = [];
    if (hideZeroDetectedEvents) and.push({ events_detected_count: { _gt: 0 } });
    if (hideChildInvocations) and.push({ source_job_id: { _is_null: true } });
    if (statusFilter !== 'all') and.push({ status: { _eq: statusFilter } });
    if (debouncedSearch) {
      const s = debouncedSearch;
      const or: Record<string, unknown>[] = [
        { source_function: { _ilike: `%${s}%` } },
        { source_user_email: { _ilike: `${s}%` } },
        { event_executions: { event_name: { _ilike: `%${s}%` } } },
      ];
      if (UUID_RE.test(s)) or.unshift({ correlation_id: { _eq: s } });
      else or.unshift({ correlation_id: { _ilike: `${s}%` } });
      and.push({ _or: or });
    }
    return and.length ? { _and: and } : {};
  }, [debouncedSearch, statusFilter, hideZeroDetectedEvents, hideChildInvocations]);

  const orderBy = useMemo(() => {
    const s = sorting[0];
    const field = (s && ORDER_FIELDS[s.id]) || 'created_at';
    return [{ [field]: s?.desc === false ? 'asc' : 'desc' }] as any;
  }, [sorting]);

  const {
    data: queryData,
    previousData,
    loading,
    error,
  } = useInvocationsListQuery({
    variables: {
      limit: pagination.pageSize,
      offset: pagination.pageIndex * pagination.pageSize,
      where: where as any,
      order_by: orderBy,
    },
    fetchPolicy: 'cache-and-network',
    errorPolicy: 'all',
    notifyOnNetworkStatusChange: false,
  });

  // Keep the previous page rendered while the next loads (no spinner flash between pages).
  const activeData = queryData ?? previousData;
  const totalCount = activeData?.invocations_aggregate?.aggregate?.count ?? 0;

  const invocationsData = useMemo(() => {
    const invocations = activeData?.invocations || [];
    return invocations.map(inv => ({
      id: inv.id,
      sourceFunction: inv.source_function || '',
      correlationId: inv.correlation_id || '',
      userEmail: inv.source_user_email || '',
      sourceOperation: inv.source_operation || '',
      sourceJobId: inv.source_job_id || undefined,
      totalDuration: inv.total_duration_ms || 0,
      eventsDetectedCount: inv.events_detected_count || 0,
      detectedEventNames: inv.event_executions?.map(e => e.event_name).filter(Boolean) || [],
      totalJobsSucceeded: inv.total_jobs_succeeded || 0,
      totalJobsFailed: inv.total_jobs_failed || 0,
      totalJobsRun: inv.total_jobs_run || 0,
      status: inv.status as 'completed' | 'failed' | 'running',
      createdAt: inv.created_at,
      // Record identity (table:id) comes back with the indexed source_record_id column
      // (plan §6.2, Phase C5) — deriving it from the 6KB payload cost ~7MB per page load.
      recordId: inv.source_table ? inv.source_table.split('.').pop() ?? undefined : undefined,
    }));
  }, [activeData]);

  const filteredInvocationsData = invocationsData;

  const handleRowClick = (invocation: Invocation) => {
    navigate(`/flow?invocationId=${invocation.id}&autoFocus=true`);
  };

  const handleViewDetails = (invocation: Invocation, e: React.MouseEvent) => {
    e.stopPropagation();
    const node: Node = {
      id: invocation.id,
      type: 'invocation',
      position: { x: 0, y: 0 },
      data: {
        sourceFunction: invocation.sourceFunction,
        correlationId: invocation.correlationId,
        status: invocation.status,
        duration: invocation.totalDuration,
        eventsCount: invocation.eventsDetectedCount,
      },
    };
    setSelectedInvocation(node);
    setDrawerOpen(true);
  };

  const getStatusBadge = (status: string) => {
    const statusStyles = {
      completed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
      failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
      running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    };
    return (
      <span
        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
          statusStyles[status as keyof typeof statusStyles]
        }`}
      >
        {status}
      </span>
    );
  };

  const getSuccessRate = (succeeded: number, total: number) => {
    if (total === 0) return 100;
    return Math.round((succeeded / total) * 100);
  };

  const getOperationColor = (operation: string) => {
    switch (operation.toUpperCase()) {
      case 'INSERT':
        return 'bg-green-500 text-white';
      case 'UPDATE':
        return 'bg-blue-500 text-white';
      case 'DELETE':
        return 'bg-red-500 text-white';
      default:
        return 'bg-gray-500 text-white';
    }
  };

  const columns = useMemo<ColumnDef<Invocation>[]>(
    () => [
      columnHelper.accessor('sourceFunction', {
        id: 'sourceFunction',
        header: 'Source Function',
        cell: info => {
          const row = info.row.original;
          const operation = row.sourceOperation;

          return (
            <div className='relative inline-flex items-center gap-1.5 pl-1 pr-3 py-1 bg-gray-100 dark:bg-gray-700 rounded-full'>
              <div className='flex items-center justify-center w-6 h-6 bg-gray-700 dark:bg-gray-900 rounded-full flex-shrink-0'>
                <CircleStackIcon className='h-3.5 w-3.5 text-gray-100 dark:text-gray-300' />
              </div>
              <span className='font-medium text-gray-900 dark:text-gray-100 text-sm'>{info.getValue()}</span>
              {operation && (
                <span
                  className={`absolute -top-0.5 -right-0.5 px-1 py-0 rounded text-[8px] font-semibold uppercase leading-tight ${getOperationColor(
                    operation
                  )}`}
                >
                  {operation}
                </span>
              )}
            </div>
          );
        },
        filterFn: 'includesString',
      }),
      columnHelper.accessor('createdAt', {
        id: 'createdAt',
        header: 'Created',
        cell: info => (
          <div className='text-gray-600 dark:text-gray-400 text-sm'>{formatRelativeTime(info.getValue())}</div>
        ),
      }),
      columnHelper.accessor('totalDuration', {
        id: 'totalDuration',
        header: 'Duration',
        cell: info => {
          const ms = info.getValue();
          let displayValue: string;

          if (ms < 1000) {
            displayValue = `${ms}ms`;
          } else if (ms < 60000) {
            const seconds = (ms / 1000).toFixed(1);
            displayValue = `${seconds}s`;
          } else {
            const minutes = (ms / 60000).toFixed(1);
            displayValue = `${minutes}m`;
          }

          return <div className='text-gray-600 dark:text-gray-400 text-sm'>{displayValue}</div>;
        },
      }),
      columnHelper.display({
        id: 'events',
        header: 'Events',
        cell: info => {
          // Undetected-count chip removed with the per-row aggregate sub-selects (perf
          // fix P1); the full detected/undetected breakdown lives in the detail drawer.
          const detected = info.row.original.eventsDetectedCount;
          return (
            <div className='flex items-center space-x-1'>
              <span
                className={`px-2 py-1 text-xs font-medium rounded ${
                  detected > 0
                    ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-400'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                }`}
              >
                {detected}
              </span>
            </div>
          );
        },
      }),
      columnHelper.display({
        id: 'jobs',
        header: 'Jobs',
        cell: info => {
          const row = info.row.original;
          return (
            <div className='flex items-center space-x-1'>
              <span className='px-2 py-1 text-xs font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-400 rounded'>
                {row.totalJobsSucceeded}
              </span>
              {row.totalJobsFailed > 0 && (
                <span className='px-2 py-1 text-xs font-medium bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-400 rounded'>
                  {row.totalJobsFailed}
                </span>
              )}
            </div>
          );
        },
      }),
      columnHelper.display({
        id: 'successRate',
        header: 'Success Rate',
        cell: info => {
          const row = info.row.original;
          const successRate = getSuccessRate(row.totalJobsSucceeded, row.totalJobsRun);
          return (
            <div className='flex items-center space-x-2'>
              <span className='text-gray-900 dark:text-gray-100 font-medium text-sm'>{successRate}%</span>
              <div className='w-16 bg-gray-200 dark:bg-gray-700 rounded-full h-2'>
                <div
                  className={`h-2 rounded-full ${
                    successRate >= 90 ? 'bg-green-500' : successRate >= 70 ? 'bg-yellow-500' : 'bg-red-500'
                  }`}
                  style={{ width: `${successRate}%` }}
                />
              </div>
            </div>
          );
        },
      }),
      columnHelper.accessor('status', {
        id: 'status',
        header: 'Status',
        cell: info => getStatusBadge(info.getValue()),
        filterFn: 'equals',
      }),
      columnHelper.display({
        id: 'detectedEvents',
        header: 'Detected Events',
        cell: info => {
          const eventNames = info.row.original.detectedEventNames;
          if (eventNames.length === 0) return null;

          return (
            <div className='flex flex-wrap gap-0.5 max-w-xs'>
              {eventNames.map((eventName, idx) => (
                <span
                  key={idx}
                  className='inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono tracking-wide bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 whitespace-nowrap'
                >
                  {eventName}
                </span>
              ))}
            </div>
          );
        },
      }),
      columnHelper.accessor('recordId', {
        id: 'recordId',
        header: 'Table',
        cell: info => (
          <div className='text-gray-600 dark:text-gray-400 text-sm font-mono text-xs'>{info.getValue() || '-'}</div>
        ),
        filterFn: 'includesString',
      }),
      columnHelper.accessor('userEmail', {
        id: 'userEmail',
        header: 'User',
        cell: info => <div className='text-gray-600 dark:text-gray-400 text-sm'>{info.getValue()}</div>,
        filterFn: 'includesString',
      }),
      columnHelper.display({
        id: 'actions',
        header: '',
        cell: info => (
          <div className='flex items-center space-x-2'>
            <button
              onClick={e => handleViewDetails(info.row.original, e)}
              className='p-1 text-gray-400 hover:text-blue-600 transition-colors'
              title='Quick Details'
            >
              <MagnifyingGlassIcon className='h-4 w-4' />
            </button>
            <ChevronRightIcon className='h-5 w-5 text-gray-400' title='View in Flow Diagram' />
          </div>
        ),
        size: 80,
      }),
    ],
    []
  );

  // Server-side pagination/sorting/filtering: the row model is exactly one page.
  const table = useReactTable({
    data: filteredInvocationsData,
    columns,
    state: { sorting, columnFilters, columnVisibility, pagination },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: setPagination,
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
    pageCount: Math.max(1, Math.ceil(totalCount / pagination.pageSize)),
    getCoreRowModel: getCoreRowModel(),
    debugTable: false,
  });

  if (loading && !activeData) {
    return (
      <div className='h-full flex flex-col'>
        <div className='bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-4'>
          <h2 className='text-xl font-semibold text-gray-900 dark:text-white'>Invocations</h2>
        </div>
        <div className='flex-1 flex items-center justify-center'>
          <div className='text-center'>
            <div className='inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600'></div>
            <p className='mt-2 text-gray-600 dark:text-gray-400'>Loading invocations...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className='h-full flex flex-col'>
        <div className='bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-4'>
          <h2 className='text-xl font-semibold text-gray-900 dark:text-white'>Invocations</h2>
        </div>
        <div className='flex-1 flex items-center justify-center'>
          <div className='text-center'>
            <ExclamationTriangleIcon className='mx-auto h-12 w-12 text-yellow-500 mb-4' />
            <p className='text-yellow-600 dark:text-yellow-400 mb-2'>Invocations data unavailable</p>
            <p className='text-sm text-gray-600 dark:text-gray-400'>The observability database may not be connected.</p>
            <p className='text-xs text-gray-500 dark:text-gray-500 mt-2'>{error.message}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className='h-full flex flex-col'>
      {/* Header */}
      <div className='bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-4'>
        <div className='flex items-center justify-between'>
          <div>
            <h2 className='text-xl font-semibold text-gray-900 dark:text-white'>Invocations</h2>
            <p className='mt-1 text-sm text-gray-600 dark:text-gray-400'>
              {totalCount.toLocaleString()} invocations{loading ? ' · refreshing…' : ''}
            </p>
          </div>

          <div className='flex items-center space-x-3'>
            <div className='relative'>
              <MagnifyingGlassIcon className='h-5 w-5 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400' />
              <input
                value={searchText}
                onChange={e => setSearchText(e.target.value)}
                className='pl-10 pr-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500'
                placeholder='Search function, event, email, correlation…'
              />
            </div>

            <select
              value={statusFilter}
              onChange={e => {
                setStatusFilter(e.target.value);
              }}
              className='px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
            >
              <option value='all'>All Status</option>
              <option value='completed'>Completed</option>
              <option value='failed'>Failed</option>
              <option value='running'>Running</option>
            </select>

            <label className='inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-600'>
              <input
                type='checkbox'
                checked={!hideZeroDetectedEvents}
                onChange={e => setHideZeroDetectedEvents(!e.target.checked)}
                className='h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500'
              />
              <span className='ml-2 text-sm text-gray-700 dark:text-gray-200'>Show Undetected Events</span>
            </label>

            <label className='inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-600'>
              <input
                type='checkbox'
                checked={hideChildInvocations}
                onChange={e => setHideChildInvocations(e.target.checked)}
                className='h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500'
              />
              <span className='ml-2 text-sm text-gray-700 dark:text-gray-200'>Hide Child Events</span>
            </label>

            <button className='inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 shadow-sm text-sm font-medium rounded-lg text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600'>
              <AdjustmentsHorizontalIcon className='h-4 w-4 mr-2' />
              Columns
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div
        className='flex-1 overflow-auto bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700'
        style={{ scrollbarGutter: 'stable both-edges' }}
      >
        {/* Scoped fix: remove any ::before/::after pseudo-elements on rows */}
        <style>{`
          /* Scope by data attribute so we don't affect other tables */
          [data-inv-table] tbody tr::before,
          [data-inv-table] tbody tr::after {
            content: none !important;
            display: none !important;
          }
        `}</style>

        <table className='w-full' data-inv-table>
          <thead className='bg-gray-50 dark:bg-gray-700/50'>
            {table.getHeaderGroups().map(headerGroup => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map(header => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();

                  return (
                    <th
                      key={header.id}
                      className='sticky top-0 z-10 bg-gray-50 dark:bg-gray-700/50 px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider'
                    >
                      {header.isPlaceholder ? null : (
                        <div
                          className={`flex items-center space-x-1 ${
                            canSort ? 'cursor-pointer select-none hover:text-gray-700 dark:hover:text-gray-200' : ''
                          }`}
                          onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                        >
                          <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                          {canSort && (
                            <span className='ml-1'>
                              {sorted === false ? (
                                <ChevronUpDownIcon className='h-4 w-4' />
                              ) : sorted === 'asc' ? (
                                <ChevronUpIcon className='h-4 w-4' />
                              ) : (
                                <ChevronDownIcon className='h-4 w-4' />
                              )}
                            </span>
                          )}
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>

          <tbody className='bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700'>
            {/* Plain <tr>: the per-row framer-motion mount animation (perf fix P7) cost a
                spring per row on every page/filter change. */}
            {table.getRowModel().rows.map(row => (
              <tr
                key={row.id}
                onClick={() => handleRowClick(row.original)}
                className='hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-colors'
              >
                {row.getVisibleCells().map(cell => (
                  <td key={cell.id} className='px-6 py-4 whitespace-nowrap text-sm'>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
            {table.getRowModel().rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className='px-6 py-8 text-center text-gray-500 dark:text-gray-400'>
                  No invocations found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className='bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 px-6 py-3'>
        <div className='flex items-center justify-between'>
          <div className='text-sm text-gray-700 dark:text-gray-300'>
            Showing{' '}
            <span className='font-medium'>
              {totalCount === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1}
            </span>{' '}
            to{' '}
            <span className='font-medium'>
              {Math.min((pagination.pageIndex + 1) * pagination.pageSize, totalCount)}
            </span>{' '}
            of <span className='font-medium'>{totalCount.toLocaleString()}</span> results
          </div>
          <div className='flex items-center space-x-2'>
            <select
              value={table.getState().pagination.pageSize}
              onChange={e => {
                table.setPageSize(Number(e.target.value));
              }}
              className='px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
            >
              {[25, 50, 100, 200].map(pageSize => (
                <option key={pageSize} value={pageSize}>
                  Show {pageSize}
                </option>
              ))}
            </select>
            <button
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className='px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed'
            >
              Previous
            </button>
            <span className='text-sm text-gray-700 dark:text-gray-300'>
              Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
            </span>
            <button
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className='px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed'
            >
              Next
            </button>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {drawerOpen && selectedInvocation && (
          <InvocationDetailDrawer node={selectedInvocation} isOpen={drawerOpen} onClose={() => setDrawerOpen(false)} />
        )}
      </AnimatePresence>
    </div>
  );
};

export default InvocationsTable;
