// Replay transport bar along the bottom edge of the flow canvas: play/pause, a
// scrubbable timeline (in the run's own milliseconds), speed control, reveal
// progress, and an exit button. Rendered only while replay mode is active.
//
// The bar runs its OWN rAF ticker to follow the clock ref while playing — the
// 60fps updates re-render only this small component, never the diagram, so the
// canvas animations (edge dashes, node spinners, activity sweeps) keep running.

import React, { useEffect, useReducer, useState } from 'react';
import {
  PlayIcon,
  PauseIcon,
  XMarkIcon,
  ArrowPathIcon,
  MinusIcon,
  PlusIcon,
  InformationCircleIcon,
  ViewfinderCircleIcon,
} from '@heroicons/react/20/solid';
import { formatDuration } from '../utils/formatDuration';
import { BASE_MS, MIN_SPEED, MAX_SPEED, SPEED_PRESETS, type FlowPlayback } from '../hooks/useFlowPlayback';

const fmtSpeed = (s: number) => `${Number(s.toFixed(2))}×`;

interface FlowPlaybackBarProps {
  playback: FlowPlayback;
  /** Center within the visible canvas when the 600px detail drawer is open. */
  drawerOpen: boolean;
}

const FlowPlaybackBar: React.FC<FlowPlaybackBarProps> = ({ playback, drawerOpen }) => {
  const { playing, total, speed, revealed, totalCount, follow } = playback;
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const [speedOpen, setSpeedOpen] = useState(false);

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

  // Esc closes the speed popover before the global cascade (drawer/replay/selection)
  // sees the keypress — capture phase on window fires ahead of bubble listeners,
  // and stopPropagation keeps it from reaching them.
  useEffect(() => {
    if (!speedOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setSpeedOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [speedOpen]);

  const time = playback.timeRef.current;
  const ended = time >= total;

  return (
    <div
      className={`absolute bottom-3 z-40 -translate-x-1/2 ${
        drawerOpen ? 'left-[calc((100%-600px)/2)] max-w-[calc(100%-640px)]' : 'left-1/2 max-w-[calc(100%-32px)]'
      }`}
    >
      <div className='flex items-center gap-3 px-3 py-2 rounded-lg bg-white/95 dark:bg-gray-800/95 border border-gray-200 dark:border-gray-700 shadow-lg backdrop-blur'>
        {/* Playing indicator + what-this-is tooltip */}
        <span className='flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-gray-500 dark:text-gray-400'>
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              playing ? 'bg-blue-500 animate-pulse' : ended ? 'bg-gray-300 dark:bg-gray-600' : 'bg-blue-400'
            }`}
          />
          REPLAY
          <span
            className='cursor-help'
            title='Visual playback of recorded history: each node lights up at the real timestamp it fired (time-scaled to your chosen speed) and stays busy for its recorded duration. Nothing is executed again — this reviews what already happened.'
          >
            <InformationCircleIcon className='h-3.5 w-3.5 text-gray-400 dark:text-gray-500' />
          </span>
        </span>

        <button
          onClick={playback.togglePlay}
          className='p-1 rounded-md text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
          title={playing ? 'Pause (Space)' : ended ? 'Replay from start (Space)' : 'Play (Space)'}
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
          title='←/→ step one frame at a time'
        />

        <span className='text-xs text-gray-600 dark:text-gray-300 tabular-nums whitespace-nowrap'>
          {formatDuration(Math.round(time))} <span className='text-gray-400 dark:text-gray-500'>/ {formatDuration(Math.round(total))}</span>
        </span>

        {/* Speed control: button opens a popover with the current value, a
            fine-grained −/slider/+ row, and preset chips. */}
        <div className='relative'>
          <button
            onClick={() => setSpeedOpen(o => !o)}
            className={`px-1.5 py-0.5 rounded text-xs font-medium tabular-nums border ${
              speedOpen
                ? 'text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-500/60 bg-blue-50 dark:bg-blue-500/10'
                : 'text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
            title='Playback speed — ↑/↓ to change (1× replays the whole run in ~10s)'
          >
            {fmtSpeed(speed)}
          </button>

          {speedOpen && (
            <>
              {/* click-away catcher */}
              <div className='fixed inset-0 z-40' onClick={() => setSpeedOpen(false)} />
              <div className='absolute bottom-full right-0 mb-2 z-50 w-72 rounded-lg bg-white/95 dark:bg-gray-800/95 border border-gray-200 dark:border-gray-700 shadow-lg backdrop-blur p-3'>
                <p className='text-[10px] font-semibold tracking-wider uppercase text-gray-400 dark:text-gray-500'>
                  Playback speed
                </p>
                <p className='mt-1 text-center text-lg font-semibold tabular-nums text-gray-900 dark:text-white'>
                  {fmtSpeed(speed)}
                </p>
                <div className='mt-2 flex items-center gap-2'>
                  <button
                    onClick={() => playback.setSpeed(speed - 0.05)}
                    className='p-1 rounded-full text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                    title='Slower'
                  >
                    <MinusIcon className='h-4 w-4' />
                  </button>
                  <input
                    type='range'
                    min={MIN_SPEED}
                    max={MAX_SPEED}
                    step={0.05}
                    value={speed}
                    onChange={e => playback.setSpeed(Number(e.target.value))}
                    className='flex-1 h-1.5 cursor-pointer accent-blue-600'
                    aria-label='Playback speed'
                  />
                  <button
                    onClick={() => playback.setSpeed(speed + 0.05)}
                    className='p-1 rounded-full text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                    title='Faster'
                  >
                    <PlusIcon className='h-4 w-4' />
                  </button>
                </div>
                <div className='mt-3 flex flex-wrap gap-1.5 justify-center'>
                  {SPEED_PRESETS.map(p => (
                    <button
                      key={p}
                      onClick={() => playback.setSpeed(p)}
                      className={`px-2 py-0.5 rounded-full text-xs font-medium tabular-nums ${
                        speed === p
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                    >
                      {fmtSpeed(p)}
                    </button>
                  ))}
                </div>
                <p className='mt-2 text-center text-[10px] text-gray-400 dark:text-gray-500 tabular-nums'>
                  whole run in {formatDuration(Math.round(BASE_MS / speed))} of wall time
                </p>
              </div>
            </>
          )}
        </div>

        {/* Camera-follow toggle: pan to each batch of newly revealed nodes */}
        <button
          onClick={playback.toggleFollow}
          aria-pressed={follow}
          className={`p-1 rounded-md ${
            follow
              ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10'
              : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
          title={
            follow
              ? 'Following newly revealed nodes — click to stop (C)'
              : 'Follow newly revealed nodes: pan the view to each step as it appears (C)'
          }
        >
          <ViewfinderCircleIcon className='h-4 w-4' />
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
          title='Exit replay (Esc)'
        >
          <XMarkIcon className='h-4 w-4' />
        </button>
      </div>
      {/* Passive hotkey hint: small enough to ignore, present enough to teach. */}
      <p className='mt-1 text-center text-[10px] text-gray-400 dark:text-gray-500 select-none'>
        Space play/pause · ← → step · ↑ ↓ speed · C follow · Esc exit
      </p>
    </div>
  );
};

export default FlowPlaybackBar;
