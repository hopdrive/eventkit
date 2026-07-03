// Replay transport bar along the bottom edge of the flow canvas: play/pause, a
// scrubbable timeline (in the run's own milliseconds), speed control, reveal
// progress, and an exit button. Rendered only while replay mode is active.
//
// The bar runs its OWN rAF ticker to follow the clock ref while playing — the
// 60fps updates re-render only this small component, never the diagram, so the
// canvas animations (edge dashes, node spinners, activity sweeps) keep running.

import React, { useEffect, useReducer } from 'react';
import { PlayIcon, PauseIcon, XMarkIcon, ArrowPathIcon } from '@heroicons/react/20/solid';
import { formatDuration } from '../utils/formatDuration';
import type { FlowPlayback } from '../hooks/useFlowPlayback';

interface FlowPlaybackBarProps {
  playback: FlowPlayback;
  /** Center within the visible canvas when the 600px detail drawer is open. */
  drawerOpen: boolean;
}

const FlowPlaybackBar: React.FC<FlowPlaybackBarProps> = ({ playback, drawerOpen }) => {
  const { playing, total, speed, revealed, totalCount } = playback;
  const [, tick] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    if (!playing) return;
    let frame: number;
    const loop = () => {
      tick();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const time = playback.timeRef.current;
  const ended = time >= total;

  return (
    <div
      className={`absolute bottom-3 z-40 -translate-x-1/2 ${
        drawerOpen ? 'left-[calc((100%-600px)/2)] max-w-[calc(100%-640px)]' : 'left-1/2 max-w-[calc(100%-32px)]'
      }`}
    >
      <div className='flex items-center gap-3 px-3 py-2 rounded-lg bg-white/95 dark:bg-gray-800/95 border border-gray-200 dark:border-gray-700 shadow-lg backdrop-blur'>
        {/* Playing indicator */}
        <span className='flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-gray-500 dark:text-gray-400'>
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              playing ? 'bg-blue-500 animate-pulse' : ended ? 'bg-gray-300 dark:bg-gray-600' : 'bg-blue-400'
            }`}
          />
          REPLAY
        </span>

        <button
          onClick={playback.togglePlay}
          className='p-1 rounded-md text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
          title={playing ? 'Pause' : ended ? 'Replay from start' : 'Play'}
        >
          {playing ? (
            <PauseIcon className='h-4 w-4' />
          ) : ended ? (
            <ArrowPathIcon className='h-4 w-4' />
          ) : (
            <PlayIcon className='h-4 w-4' />
          )}
        </button>

        {/* Scrubbable timeline */}
        <input
          type='range'
          min={0}
          max={total}
          step={Math.max(total / 500, 1)}
          value={time}
          onChange={e => {
            playback.seek(Number(e.target.value));
            tick(); // reflect the new position immediately even while paused
          }}
          className='w-56 sm:w-72 h-1.5 cursor-pointer accent-blue-600'
          aria-label='Replay timeline'
        />

        <span className='text-xs text-gray-600 dark:text-gray-300 tabular-nums whitespace-nowrap'>
          {formatDuration(Math.round(time))} <span className='text-gray-400 dark:text-gray-500'>/ {formatDuration(Math.round(total))}</span>
        </span>

        <button
          onClick={playback.cycleSpeed}
          className='px-1.5 py-0.5 rounded text-xs font-medium tabular-nums text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'
          title='Playback speed (1× replays the whole run in ~10s)'
        >
          {speed}×
        </button>

        <span
          className='text-[11px] text-gray-400 dark:text-gray-500 tabular-nums whitespace-nowrap'
          title='Nodes revealed so far'
        >
          {revealed.size}/{totalCount}
        </span>

        <button
          onClick={playback.exit}
          className='p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
          title='Exit replay'
        >
          <XMarkIcon className='h-4 w-4' />
        </button>
      </div>
    </div>
  );
};

export default FlowPlaybackBar;
