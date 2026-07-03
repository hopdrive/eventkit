import React from 'react';
import { XMarkIcon } from '@heroicons/react/20/solid';

// Discoverability panel for the flow canvas hotkeys — toggled by ? or the
// toolbar's ? button. Static content: the behavior lives in useFlowHotkeys;
// keep the two files in sync when adding or changing a binding.

const Kbd: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <kbd className='inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-[11px] font-semibold text-gray-700 dark:text-gray-200 shadow-sm'>
    {children}
  </kbd>
);

const Row: React.FC<{ keys: string[]; label: string }> = ({ keys, label }) => (
  <div className='flex items-center justify-between gap-4 py-0.5'>
    <span className='text-[13px] text-gray-600 dark:text-gray-300'>{label}</span>
    <span className='flex items-center gap-1 shrink-0'>
      {keys.map(k => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  </div>
);

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div>
    <p className='text-[10px] font-semibold tracking-wider uppercase text-gray-400 dark:text-gray-500 mb-1.5'>
      {title}
    </p>
    <div className='space-y-0.5'>{children}</div>
  </div>
);

const KeyboardShortcutsOverlay: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <div
    className='fixed inset-0 z-50 flex items-center justify-center p-4'
    role='dialog'
    aria-modal='true'
    aria-label='Keyboard shortcuts'
  >
    <div className='absolute inset-0 bg-black/40 backdrop-blur-[2px]' onClick={onClose} />
    <div className='relative w-full max-w-2xl rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-2xl p-5'>
      <div className='flex items-center justify-between mb-4'>
        <h2 className='text-sm font-semibold text-gray-900 dark:text-white'>Keyboard shortcuts</h2>
        <button
          onClick={onClose}
          className='p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'
          title='Close (Esc)'
        >
          <XMarkIcon className='h-4 w-4' />
        </button>
      </div>
      <div className='grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-5'>
        <Section title='Navigate'>
          <Row keys={['←', '↑', '↓', '→']} label='Walk selection between steps' />
          <Row keys={['W', 'A', 'S', 'D']} label='Same, for the left hand' />
          <Row keys={['Home']} label='Jump to the origin invocation' />
          <Row keys={['/']} label='Search nodes' />
          <Row keys={['F']} label='Fit the whole flow in view' />
          <Row keys={['+', '−']} label='Zoom in / out' />
        </Section>
        <Section title='Inspect'>
          <Row keys={['Enter']} label='Open details for the selected step' />
          <Row keys={['Backspace']} label='Back to the previous step (details open)' />
          <Row keys={['Esc']} label='Close details · exit replay · clear selection' />
        </Section>
        <Section title='Replay'>
          <Row keys={['R']} label='Replay the chain (again = restart)' />
          <Row keys={['Space']} label='Play / pause' />
          <Row keys={['←', '→']} label='Step one frame back / forward' />
          <Row keys={['↑', '↓']} label='Playback speed up / down' />
          <Row keys={['Home', 'End']} label='Jump to start / end' />
        </Section>
        <Section title='Overlays'>
          <Row keys={['E']} label='Toggle “Show expected”' />
          <Row keys={['U']} label='Toggle “Show undetected”' />
          <Row keys={['O']} label='Toggle “Flag off-contract”' />
          <Row keys={['?']} label='Show / hide this panel' />
        </Section>
      </div>
      <p className='mt-4 text-[11px] text-gray-400 dark:text-gray-500'>
        Arrows and WASD keep working while the details panel is open — the panel follows the selection.
        Shortcuts pause while you’re typing in a field.
      </p>
    </div>
  </div>
);

export default KeyboardShortcutsOverlay;
