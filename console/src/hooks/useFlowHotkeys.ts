import { useEffect, useRef } from 'react';
import type { Node } from 'reactflow';
import type { FlowPlayback } from './useFlowPlayback';

// Global keyboard layer for the flow canvas. ONE window listener owns every
// binding; ReactFlow's own keyboard handling is disabled on the canvas
// (disableKeyboardA11y — its default binds arrows to MOVE the selected node,
// which we replace with selection-walking). Handlers read the latest props
// through a ref, so the listener registers once and never goes stale.
//
// KeyboardShortcutsOverlay documents these bindings for users — keep the two
// files in sync when adding or changing a key.

export type NavDirection = 'left' | 'right' | 'up' | 'down';

const NAV_KEYS: Record<string, NavDirection> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  a: 'left',
  d: 'right',
  w: 'up',
  s: 'down',
};

const nodeCenter = (n: Node) => ({
  x: n.position.x + (n.width ?? 220) / 2,
  y: n.position.y + (n.height ?? 70) / 2,
});

// Directional nearest-neighbor over node centers. The layout flows left→right
// (invocation → events → jobs), so geometric direction matches graph direction.
// Off-axis distance is penalized — more heavily for vertical moves — so ↑/↓
// walk siblings within a column instead of drifting across columns.
export const nearestInDirection = (nodes: Node[], from: Node, dir: NavDirection): Node | null => {
  const c = nodeCenter(from);
  const horizontal = dir === 'left' || dir === 'right';
  let best: Node | null = null;
  let bestScore = Infinity;
  for (const n of nodes) {
    if (n.id === from.id) continue;
    const p = nodeCenter(n);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const primary = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    if (primary <= 8) continue; // must actually lie in that direction
    const off = horizontal ? Math.abs(dy) : Math.abs(dx);
    const score = primary + off * (horizontal ? 2 : 3);
    if (score < bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return best;
};

// Keys must not fire while the user is typing. Checkbox/radio/button inputs are
// controls, not text entry — F should still fit the view right after toggling an
// overlay checkbox; a focused range slider keeps its native arrow behavior.
const isTextEntry = (el: EventTarget | null): el is HTMLElement => {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'file'].includes(type);
  }
  return false;
};

export interface FlowHotkeyOptions {
  /** Currently navigable canvas nodes (rendered, selectable — replay filters
   *  un-revealed nodes out by setting selectable: false). */
  getNodes: () => Node[];
  selectedNode: Node | null;
  drawerOpen: boolean;
  canDrawerBack: boolean;
  helpOpen: boolean;
  playback: FlowPlayback;
  /** Select a node and animate-center it (drawer, if open, follows along). */
  onNavigate: (node: Node) => void;
  onOpenDrawer: () => void;
  onCloseDrawer: () => void;
  onDrawerBack: () => void;
  onClearSelection: () => void;
  onStartReplay: () => void;
  onFitView: () => void;
  onZoom: (dir: 1 | -1) => void;
  onFocusSearch: () => void;
  onToggleHelp: (open?: boolean) => void;
  onToggleFlag: (key: 'expected' | 'offcontract' | 'undetected') => void;
  onCycleSpeed: (dir: 1 | -1) => void;
}

export const useFlowHotkeys = (options: FlowHotkeyOptions): void => {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const o = latest.current;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // browser/OS chords are not ours
      const target = e.target;
      if (isTextEntry(target)) {
        if (e.key === 'Escape') target.blur(); // Esc backs out of the search box
        return;
      }
      // Focus sits on a button/checkbox/link: let Enter and Space activate it.
      const onControl =
        target instanceof HTMLElement && !!target.closest('button, a, label, input, select, [role="button"]');

      // Keys that work with or without Shift (?, +, < are shifted on most layouts).
      switch (e.key) {
        case '?':
          e.preventDefault();
          o.onToggleHelp();
          return;
        case 'Escape':
          // Outermost layer first: help panel → drawer → replay → selection.
          if (o.helpOpen) o.onToggleHelp(false);
          else if (o.drawerOpen) o.onCloseDrawer();
          else if (o.playback.active) o.playback.exit();
          else if (o.selectedNode) o.onClearSelection();
          return;
        case 'Enter':
          if (onControl) return;
          if (o.selectedNode && !o.drawerOpen) {
            e.preventDefault();
            o.onOpenDrawer();
          }
          return;
        case ' ':
          if (onControl) return;
          if (o.playback.active) {
            e.preventDefault(); // and don't scroll the page
            o.playback.togglePlay();
          }
          return;
        case 'Backspace':
          // Swallow even without history: a stray Backspace must never trigger
          // browser back-navigation while the drawer is open.
          if (o.drawerOpen) {
            e.preventDefault();
            if (o.canDrawerBack) o.onDrawerBack();
          }
          return;
        case 'Home':
          e.preventDefault();
          if (o.playback.active) o.playback.step(-1e12);
          else {
            const nodes = o.getNodes();
            const origin = nodes.find(n => n.data?.isOrigin) ?? nodes[0];
            if (origin) o.onNavigate(origin);
          }
          return;
        case 'End':
          if (o.playback.active) {
            e.preventDefault();
            o.playback.step(1e12);
          }
          return;
        case '<':
          if (o.playback.active) o.onCycleSpeed(-1);
          return;
        case '>':
          if (o.playback.active) o.onCycleSpeed(1);
          return;
        case '+':
        case '=':
          o.onZoom(1);
          return;
        case '-':
        case '_':
          o.onZoom(-1);
          return;
      }

      if (e.shiftKey) return; // Shift+letter combos are not ours

      switch (e.key) {
        case 'f':
          o.onFitView();
          return;
        case '/':
          e.preventDefault(); // Firefox quick-find
          o.onFocusSearch();
          return;
        case 'r':
          if (o.playback.hasTimeline) o.onStartReplay(); // start, or restart from 0
          return;
        case 'e':
          o.onToggleFlag('expected');
          return;
        case 'u':
          o.onToggleFlag('undetected');
          return;
        case 'o':
          o.onToggleFlag('offcontract');
          return;
        case ',': // video-editor convention, same as ←/→ during replay
          if (o.playback.active) o.playback.step(-1);
          return;
        case '.':
          if (o.playback.active) o.playback.step(1);
          return;
        case 'c':
          if (o.playback.active) o.playback.toggleFollow();
          return;
      }

      const dir = NAV_KEYS[e.key];
      if (!dir) return;
      e.preventDefault(); // arrows must never scroll the page or move canvas nodes

      // Replay owns the ARROW keys: ←/→ scrub one frame, ↑/↓ change speed.
      // WASD keeps walking node selection even while the replay runs.
      if (o.playback.active && e.key.startsWith('Arrow')) {
        if (dir === 'left') o.playback.step(-1);
        else if (dir === 'right') o.playback.step(1);
        else o.onCycleSpeed(dir === 'up' ? 1 : -1);
        return;
      }

      const nodes = o.getNodes();
      if (nodes.length === 0) return;
      if (!o.selectedNode) {
        // First press lands on the invocation being viewed (or the chain origin).
        const entry = nodes.find(n => n.data?.isFocus) ?? nodes.find(n => n.data?.isOrigin) ?? nodes[0];
        o.onNavigate(entry);
        return;
      }
      // Re-resolve the selection against live nodes for fresh dimensions.
      const from = nodes.find(n => n.id === o.selectedNode!.id) ?? o.selectedNode;
      const next = nearestInDirection(nodes, from, dir);
      if (next) o.onNavigate(next);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
};

export default useFlowHotkeys;
