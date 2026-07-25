// prettier-ignore

import React, { useMemo, useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  MagnifyingGlassIcon,
  ExclamationTriangleIcon,
  ChevronRightIcon,
  XMarkIcon,
  CircleStackIcon,
} from '@heroicons/react/24/outline';
import { useChainsListQuery, useChainsCountQuery, useChainMemberFactsQuery } from '../types/generated';
import { formatRelativeTime } from '../utils/formatTime';

// The origin chip uses the same amber tone as the flow canvas' user-action node, so a
// chain's origin reads the same everywhere. Absent origin → no chip; the row leads with
// the root's event/function instead.
const ORIGIN_CHIP =
  'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30';

const UUID_ANYWHERE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface ChainsTableProps {
  correlationSearch?: string;
}

/** One chain-summary row (a root invocation), plus the per-page member facts merged in. */
interface ChainRow {
  id: string;
  correlationId: string;
  originAction: string | null;
  chainStatus: string | null;
  lastActivityAt: string | null;
  sourceFunction: string;
  sourceOperation: string;
  sourceTable: string | null;
  userEmail: string;
  rootStatus: string;
  createdAt: string;
  memberCount?: number;
  spanMs?: number;
}

function formatSpan(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

const ChainsTable: React.FC<ChainsTableProps> = ({ correlationSearch = '' }) => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Persistent, deep-linkable view state lives in the URL so a chains view can be shared.
  const errorsOnly = searchParams.get('errors') === '1';
  const actionFilter = searchParams.get('action') || '';

  const [searchText, setSearchText] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 50 });

  // Header correlation-search drives the same server-side search.
  useEffect(() => {
    setSearchText(correlationSearch);
  }, [correlationSearch]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchText.trim()), 250);
    return () => clearTimeout(t);
  }, [searchText]);

  // Back to page 1 whenever the result-set definition changes.
  useEffect(() => {
    setPagination(p => (p.pageIndex === 0 ? p : { ...p, pageIndex: 0 }));
  }, [debouncedSearch, errorsOnly, actionFilter]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  // Chains are plain root rows — one WHERE clause, no group-by. Every predicate is on an
  // indexed root column.
  const where = useMemo(() => {
    const and: Record<string, unknown>[] = [{ is_chain_root: { _eq: true } }];
    if (errorsOnly) and.push({ chain_status: { _eq: 'errored' } });
    if (actionFilter) and.push({ origin_action: { _eq: actionFilter } });
    if (debouncedSearch) {
      const s = debouncedSearch;
      const or: Record<string, unknown>[] = [
        { source_function: { _ilike: `%${s}%` } },
        { source_user_email: { _ilike: `${s}%` } },
        { origin_action: { _ilike: `%${s}%` } },
      ];
      if (UUID_ANYWHERE_RE.test(s)) or.unshift({ correlation_id: { _eq: s } });
      else or.unshift({ correlation_id: { _ilike: `${s}%` } });
      and.push({ _or: or });
    }
    return { _and: and };
  }, [errorsOnly, actionFilter, debouncedSearch]);

  const { data: queryData, previousData, loading, error } = useChainsListQuery({
    variables: {
      limit: pagination.pageSize,
      offset: pagination.pageIndex * pagination.pageSize,
      where: where as any,
      order_by: [{ chain_last_activity_at: 'desc_nulls_last' }] as any,
    },
    fetchPolicy: 'cache-and-network',
    errorPolicy: 'all',
  });

  const { data: countData, previousData: prevCountData } = useChainsCountQuery({
    variables: { where: where as any },
    fetchPolicy: 'cache-and-network',
    errorPolicy: 'all',
  });

  const activeData = queryData ?? previousData;
  const activeCount = (countData ?? prevCountData)?.invocations_aggregate?.aggregate?.count;
  const totalCount = activeCount ?? 0;
  const countKnown = activeCount !== undefined;

  const rows = useMemo<ChainRow[]>(() => {
    return (activeData?.invocations || []).map(inv => ({
      id: inv.id,
      correlationId: inv.correlation_id || '',
      originAction: inv.origin_action ?? null,
      chainStatus: inv.chain_status ?? null,
      lastActivityAt: inv.chain_last_activity_at ?? null,
      sourceFunction: inv.source_function || '',
      sourceOperation: inv.source_operation || '',
      sourceTable: inv.source_table ?? null,
      userEmail: inv.source_user_email || '',
      rootStatus: inv.status,
      createdAt: inv.created_at,
    }));
  }, [activeData]);

  // Per-page member facts: one indexed _in query over just this page's correlation ids,
  // aggregated client-side into a count + span per chain. Never a global group-by.
  const pageCorrelationIds = useMemo(
    () => Array.from(new Set(rows.map(r => r.correlationId).filter(Boolean))),
    [rows]
  );
  const { data: factsData } = useChainMemberFactsQuery({
    variables: { correlationIds: pageCorrelationIds },
    skip: pageCorrelationIds.length === 0,
    fetchPolicy: 'cache-and-network',
    errorPolicy: 'all',
  });
  const factsByCorrelation = useMemo(() => {
    const map = new Map<string, { count: number; min: number; max: number }>();
    for (const m of factsData?.invocations || []) {
      const key = m.correlation_id || '';
      const t = new Date(m.created_at).getTime();
      const cur = map.get(key);
      if (!cur) map.set(key, { count: 1, min: t, max: t });
      else {
        cur.count += 1;
        cur.min = Math.min(cur.min, t);
        cur.max = Math.max(cur.max, t);
      }
    }
    return map;
  }, [factsData]);

  const chainRows = useMemo<ChainRow[]>(
    () =>
      rows.map(r => {
        const f = factsByCorrelation.get(r.correlationId);
        return f ? { ...r, memberCount: f.count, spanMs: Math.max(0, f.max - f.min) } : r;
      }),
    [rows, factsByCorrelation]
  );

  const openChain = (correlationId: string) => {
    if (correlationId) navigate(`/flow?correlationId=${encodeURIComponent(correlationId)}&autoFocus=true`);
  };

  // Row status color follows chain_status, so a root that itself succeeded but whose chain
  // errored reads as errored.
  const chainStatusBadge = (status: string | null) => {
    const styles: Record<string, string> = {
      errored: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
      ok: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
      incomplete: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
    };
    const label = status ?? 'unknown';
    return (
      <span
        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
          styles[label] ?? 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300'
        }`}
      >
        {label}
      </span>
    );
  };

  const pageCount = countKnown
    ? Math.max(1, Math.ceil(totalCount / pagination.pageSize))
    : chainRows.length === pagination.pageSize
      ? pagination.pageIndex + 2
      : pagination.pageIndex + 1;

  if (error && !activeData) {
    return (
      <div className='flex-1 flex items-center justify-center'>
        <div className='text-center'>
          <ExclamationTriangleIcon className='mx-auto h-12 w-12 text-yellow-500 mb-4' />
          <p className='text-yellow-600 dark:text-yellow-400 mb-2'>Chains data unavailable</p>
          <p className='text-xs text-gray-500 dark:text-gray-500 mt-2'>{error.message}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Toolbar */}
      <div className='flex items-center space-x-3'>
        <div className='relative'>
          <MagnifyingGlassIcon className='h-5 w-5 absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400' />
          <input
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            className='pl-10 pr-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500'
            placeholder='Search origin, function, email, correlation…'
          />
        </div>

        <button
          onClick={() => setParam('errors', errorsOnly ? null : '1')}
          className={`inline-flex items-center px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
            errorsOnly
              ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-900/20 dark:text-red-300'
              : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600'
          }`}
        >
          <ExclamationTriangleIcon className='h-4 w-4 mr-2' />
          Errored chains only
        </button>

        {actionFilter && (
          <span className={`${ORIGIN_CHIP} gap-1.5`}>
            {actionFilter}
            <button onClick={() => setParam('action', null)} title='Clear action filter'>
              <XMarkIcon className='h-3.5 w-3.5' />
            </button>
          </span>
        )}
      </div>

      {/* Table */}
      <div
        className='flex-1 overflow-auto bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 mt-4'
        style={{ scrollbarGutter: 'stable both-edges' }}
      >
        <table className='w-full'>
          <thead className='bg-gray-50 dark:bg-gray-700/50'>
            <tr>
              {['Chain', 'User', 'Status', 'Last activity', 'Invocations'].map(h => (
                <th
                  key={h}
                  className='sticky top-0 z-10 bg-gray-50 dark:bg-gray-700/50 px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider'
                >
                  {h}
                </th>
              ))}
              <th className='sticky top-0 z-10 bg-gray-50 dark:bg-gray-700/50 px-6 py-3' />
            </tr>
          </thead>
          <tbody className='bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700'>
            {chainRows.map(row => (
              <tr
                key={row.id}
                onClick={() => openChain(row.correlationId)}
                className='hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-colors'
              >
                <td className='px-6 py-4 text-sm'>
                  {row.originAction ? (
                    <div className='flex items-center gap-2'>
                      <span className={ORIGIN_CHIP}>{row.originAction}</span>
                      <span className='text-xs text-gray-400 dark:text-gray-500 font-mono truncate max-w-[16rem]'>
                        {row.correlationId}
                      </span>
                    </div>
                  ) : (
                    <div className='flex items-center gap-2'>
                      <div className='flex items-center justify-center w-6 h-6 bg-gray-700 dark:bg-gray-900 rounded-full flex-shrink-0'>
                        <CircleStackIcon className='h-3.5 w-3.5 text-gray-100 dark:text-gray-300' />
                      </div>
                      <span className='font-medium text-gray-900 dark:text-gray-100'>
                        {row.sourceTable ? row.sourceTable.split('.').pop() : row.sourceFunction}
                        {row.sourceOperation ? ` ${row.sourceOperation}` : ''}
                      </span>
                      <span className='text-xs text-gray-400 dark:text-gray-500'>via {row.sourceFunction}</span>
                    </div>
                  )}
                </td>
                <td className='px-6 py-4 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400'>
                  {row.userEmail || '—'}
                </td>
                <td className='px-6 py-4 whitespace-nowrap'>{chainStatusBadge(row.chainStatus)}</td>
                <td className='px-6 py-4 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400'>
                  {row.lastActivityAt ? formatRelativeTime(row.lastActivityAt) : '—'}
                </td>
                <td className='px-6 py-4 whitespace-nowrap text-sm text-gray-600 dark:text-gray-400'>
                  {row.memberCount !== undefined ? (
                    <span>
                      {row.memberCount}
                      {row.memberCount > 1 && row.spanMs !== undefined ? (
                        <span className='text-gray-400 dark:text-gray-500'> · {formatSpan(row.spanMs)}</span>
                      ) : null}
                    </span>
                  ) : (
                    '…'
                  )}
                </td>
                <td className='px-6 py-4 whitespace-nowrap text-right'>
                  <ChevronRightIcon className='h-5 w-5 text-gray-400 inline' />
                </td>
              </tr>
            ))}
            {chainRows.length === 0 && (
              <tr>
                <td colSpan={6} className='px-6 py-8 text-center text-gray-500 dark:text-gray-400'>
                  {errorsOnly ? 'No errored chains' : 'No chains found'}
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
            {countKnown ? `${totalCount.toLocaleString()} chains` : 'Counting…'}
            {loading ? ' · refreshing…' : ''}
          </div>
          <div className='flex items-center space-x-2'>
            <button
              onClick={() => setPagination(p => ({ ...p, pageIndex: Math.max(0, p.pageIndex - 1) }))}
              disabled={pagination.pageIndex === 0}
              className='px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed'
            >
              Previous
            </button>
            <span className='text-sm text-gray-700 dark:text-gray-300'>
              Page {pagination.pageIndex + 1} of {pageCount}
            </span>
            <button
              onClick={() => setPagination(p => ({ ...p, pageIndex: Math.min(pageCount - 1, p.pageIndex + 1) }))}
              disabled={pagination.pageIndex >= pageCount - 1}
              className='px-3 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed'
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default ChainsTable;
