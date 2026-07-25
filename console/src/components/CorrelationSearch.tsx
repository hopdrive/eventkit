import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  MagnifyingGlassIcon,
  ClockIcon,
  UserIcon,
  CogIcon,
  BoltIcon,
  WrenchScrewdriverIcon,
  LinkIcon,
  XMarkIcon,
  BellAlertIcon,
  ArrowRightCircleIcon,
} from '@heroicons/react/24/outline';
import { useGroupedSearchLazyQuery, useOriginActionSuggestLazyQuery } from '../types/generated';

interface CorrelationSearchProps {
  value: string;
  onChange: (value: string) => void;
}

// A correlation id is worth an exact-match probe when the term contains a UUID
// (HopDrive tokens look like `event-handlers.<uuid>` — the whole string is the id).
const UUID_ANYWHERE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// A full correlation id: `<function>.<uuid>` (the stable chain key). Paste one and land
// straight on its flow.
const FULL_CORRELATION_RE = /^[\w:.-]+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A bare invocation UUID (nothing else) — open that specific invocation's flow.
const BARE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Debounced, grouped, server-side search (perf fixes P2/P3, UX U1 — plan §4.1).
// Every predicate hits an indexed column; the legacy JSONB payload-cast scan is gone.
const CorrelationSearch: React.FC<CorrelationSearchProps> = ({ value, onChange }) => {
  const navigate = useNavigate();
  const [isFocused, setIsFocused] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [runSearch, { data: searchData, loading }] = useGroupedSearchLazyQuery();
  const [runOriginSearch, { data: originData }] = useOriginActionSuggestLazyQuery();

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
        setIsFocused(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // 250ms debounce: one grouped query per typing pause, not one scan per keystroke.
  useEffect(() => {
    if (value.length < 2) return;
    const t = setTimeout(() => {
      const term = value.trim();
      runSearch({
        variables: {
          exactCorrelation: term,
          prefix: `${term}%`,
          infix: `%${term}%`,
          isCorrelationLike: UUID_ANYWHERE_RE.test(term),
        },
      });
      runOriginSearch({ variables: { prefix: `${term}%` } });
    }, 250);
    return () => clearTimeout(t);
  }, [value, runSearch, runOriginSearch]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    onChange(newValue);
    setShowSuggestions(newValue.length >= 2);
  };

  const handleFocus = () => {
    setIsFocused(true);
    if (value.length >= 2) setShowSuggestions(true);
  };

  const closeSuggestions = () => {
    setShowSuggestions(false);
    setIsFocused(false);
    inputRef.current?.blur();
  };

  // Chain/function rows adopt the value into the page-level search; event/job rows
  // jump straight to the owning invocation's flow view (deep link, UX U4).
  const adoptValue = (v: string | null | undefined) => {
    if (v) onChange(v);
    closeSuggestions();
  };
  const goToInvocation = (invocationId: string | null | undefined) => {
    if (invocationId) navigate(`/flow?invocationId=${invocationId}&autoFocus=true`);
    closeSuggestions();
  };
  // The chain permalink (stable deep-link contract): resolves the correlation id to its
  // root and renders the flow.
  const goToChain = (correlationId: string | null | undefined) => {
    if (correlationId) navigate(`/flow?correlationId=${encodeURIComponent(correlationId)}&autoFocus=true`);
    closeSuggestions();
  };
  // An origin action opens the chains index filtered to that action (the canonical
  // per-action index link).
  const goToAction = (action: string | null | undefined) => {
    if (action) navigate(`/invocations?action=${encodeURIComponent(action)}`);
    closeSuggestions();
  };

  const clearSearch = () => {
    onChange('');
    setShowSuggestions(false);
    inputRef.current?.focus();
  };

  const statusDot = (status: string | null | undefined) => {
    switch (status) {
      case 'completed':
        return <div className='w-2 h-2 bg-green-500 rounded-full flex-shrink-0' />;
      case 'failed':
        return <div className='w-2 h-2 bg-red-500 rounded-full flex-shrink-0' />;
      case 'running':
        return <div className='w-2 h-2 bg-blue-500 rounded-full animate-pulse flex-shrink-0' />;
      default:
        return <div className='w-2 h-2 bg-gray-400 rounded-full flex-shrink-0' />;
    }
  };

  const correlationMatches = searchData?.correlation_matches ?? [];
  const functionMatches = searchData?.function_matches ?? [];
  const eventMatches = searchData?.event_matches ?? [];
  const jobMatches = searchData?.job_matches ?? [];
  const originActions = (originData?.invocations ?? [])
    .map(i => i.origin_action)
    .filter((a): a is string => typeof a === 'string' && a.length > 0);

  // Paste-anything: a full correlation id or a bare invocation UUID lands the user straight
  // on the right flow, above the fuzzy groups.
  const term = value.trim();
  const directChain = FULL_CORRELATION_RE.test(term) ? term : null;
  const directInvocation = !directChain && BARE_UUID_RE.test(term) ? term : null;

  const totalMatches =
    correlationMatches.length +
    functionMatches.length +
    eventMatches.length +
    jobMatches.length +
    originActions.length +
    (directChain ? 1 : 0) +
    (directInvocation ? 1 : 0);

  const groupHeader = (label: string, Icon: typeof LinkIcon) => (
    <div className='flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide border-b border-gray-100 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/40'>
      <Icon className='h-3.5 w-3.5' />
      {label}
    </div>
  );

  const rowClass =
    'w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors border-b border-gray-50 dark:border-gray-700/50 last:border-b-0';

  return (
    <div ref={containerRef} className='relative w-full max-w-md'>
      <div
        className={`
          relative flex items-center border rounded-lg transition-all duration-200
          ${isFocused ? 'border-blue-500 ring-2 ring-blue-500/20 shadow-sm' : 'border-gray-300 dark:border-gray-600'}
          bg-white dark:bg-gray-700
        `}
      >
        <MagnifyingGlassIcon className='h-5 w-5 text-gray-400 ml-3 flex-shrink-0' />

        <input
          ref={inputRef}
          type='text'
          value={value}
          onChange={handleInputChange}
          onFocus={handleFocus}
          placeholder='Search event, job, function, email, or correlation ID…'
          className='flex-1 px-3 py-2 text-sm bg-transparent text-gray-900 dark:text-gray-100 placeholder-gray-500 border-none outline-none'
        />

        {value && (
          <button
            onClick={clearSearch}
            className='p-1 mr-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors'
          >
            <XMarkIcon className='h-4 w-4' />
          </button>
        )}
      </div>

      <AnimatePresence>
        {showSuggestions && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.15 }}
            className='absolute top-full left-0 right-0 mt-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg z-50 max-h-96 overflow-auto'
          >
            {loading && value.length >= 2 && (
              <div className='p-4 text-center text-sm text-gray-500 dark:text-gray-400'>Searching…</div>
            )}

            {!loading && totalMatches === 0 && value.length >= 2 && (
              <div className='p-4 text-center text-sm text-gray-500 dark:text-gray-400'>
                No results found for "{value}"
              </div>
            )}

            {(directChain || directInvocation) && (
              <div>
                {groupHeader('Open', ArrowRightCircleIcon)}
                {directChain && (
                  <button onClick={() => goToChain(directChain)} className={rowClass}>
                    <div className='flex items-center space-x-3'>
                      <LinkIcon className='h-4 w-4 text-gray-400 flex-shrink-0' />
                      <div className='flex-1 min-w-0'>
                        <div className='text-sm font-medium text-gray-900 dark:text-gray-100'>Open chain</div>
                        <div className='text-xs text-gray-500 dark:text-gray-400 font-mono truncate'>{directChain}</div>
                      </div>
                    </div>
                  </button>
                )}
                {directInvocation && (
                  <button onClick={() => goToInvocation(directInvocation)} className={rowClass}>
                    <div className='flex items-center space-x-3'>
                      <ArrowRightCircleIcon className='h-4 w-4 text-gray-400 flex-shrink-0' />
                      <div className='flex-1 min-w-0'>
                        <div className='text-sm font-medium text-gray-900 dark:text-gray-100'>Open invocation</div>
                        <div className='text-xs text-gray-500 dark:text-gray-400 font-mono truncate'>{directInvocation}</div>
                      </div>
                    </div>
                  </button>
                )}
              </div>
            )}

            {originActions.length > 0 && (
              <div>
                {groupHeader('Origin actions', BellAlertIcon)}
                {originActions.map(action => (
                  <button key={action} onClick={() => goToAction(action)} className={rowClass}>
                    <div className='flex items-center space-x-3'>
                      <span className='inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30'>
                        {action}
                      </span>
                      <span className='text-xs text-gray-500 dark:text-gray-400'>chains for this action</span>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {correlationMatches.length > 0 && (
              <div>
                {groupHeader('Chains', LinkIcon)}
                {correlationMatches.map(m => (
                  <button key={m.id} onClick={() => goToChain(m.correlation_id)} className={rowClass}>
                    <div className='flex items-center space-x-3'>
                      {statusDot(m.status)}
                      <div className='flex-1 min-w-0'>
                        <div className='text-sm font-medium text-gray-900 dark:text-gray-100 font-mono truncate'>
                          {m.correlation_id}
                        </div>
                        <div className='flex items-center space-x-3 text-xs text-gray-500 dark:text-gray-400'>
                          <span className='flex items-center gap-1'>
                            <CogIcon className='h-3 w-3' />
                            {m.source_function}
                          </span>
                          <span className='flex items-center gap-1'>
                            <ClockIcon className='h-3 w-3' />
                            {new Date(m.created_at).toLocaleTimeString()}
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {eventMatches.length > 0 && (
              <div>
                {groupHeader('Events', BoltIcon)}
                {eventMatches.map(m => (
                  <button key={m.id} onClick={() => goToInvocation(m.invocation_id)} className={rowClass}>
                    <div className='flex items-center space-x-3'>
                      {statusDot(m.status)}
                      <div className='flex-1 min-w-0'>
                        <div className='text-sm font-mono text-blue-700 dark:text-blue-400 truncate'>
                          {m.event_name}
                        </div>
                        <div className='text-xs text-gray-500 dark:text-gray-400'>
                          {new Date(m.created_at).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {jobMatches.length > 0 && (
              <div>
                {groupHeader('Jobs', WrenchScrewdriverIcon)}
                {jobMatches.map(m => (
                  <button key={m.id} onClick={() => goToInvocation(m.invocation_id)} className={rowClass}>
                    <div className='flex items-center space-x-3'>
                      {statusDot(m.status)}
                      <div className='flex-1 min-w-0'>
                        <div className='text-sm font-mono text-purple-700 dark:text-purple-400 truncate'>
                          {m.job_name}
                        </div>
                        <div className='text-xs text-gray-500 dark:text-gray-400'>
                          {new Date(m.created_at).toLocaleString()}
                          {typeof m.duration_ms === 'number' ? ` · ${m.duration_ms}ms` : ''}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {functionMatches.length > 0 && (
              <div>
                {groupHeader('Functions & Users', CogIcon)}
                {functionMatches.map(m => (
                  <button
                    key={m.id}
                    onClick={() => adoptValue(m.source_function || m.source_user_email)}
                    className={rowClass}
                  >
                    <div className='flex items-center space-x-3'>
                      {statusDot(m.status)}
                      <div className='flex-1 min-w-0'>
                        <div className='text-sm font-medium text-gray-900 dark:text-gray-100 truncate'>
                          {m.source_function}
                        </div>
                        {m.source_user_email && (
                          <div className='flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 truncate'>
                            <UserIcon className='h-3 w-3' />
                            {m.source_user_email}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {value.length < 2 && (
              <div className='p-4 text-xs text-gray-500 dark:text-gray-400'>
                <div className='space-y-2'>
                  <p className='font-medium'>Search Tips:</p>
                  <ul className='space-y-1 ml-2'>
                    <li>• Type at least 2 characters to search</li>
                    <li>• Event names (move.pickup.started), job names (runARV2)</li>
                    <li>• Function names, user emails, or a correlation ID</li>
                    <li>• Click an event or job result to open its flow</li>
                  </ul>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default CorrelationSearch;
