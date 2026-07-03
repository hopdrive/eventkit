import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Node } from 'reactflow';

// Chain replay clock. Every observed node carries created_at (ms precision) and a
// duration, so the run can be replayed: a node is REVEALED when the clock passes
// its start offset and RUNNING until the clock passes its end. `time` is measured
// in the run's own milliseconds (scrubber + labels speak real chain time); the
// wall-clock mapping is normalized — 1× plays the WHOLE timeline in BASE_MS
// regardless of real span, because raw wall-clock replay is useless at both
// extremes (a 300ms chain flashes by; a 4-minute chain is unwatchable).
const BASE_MS = 10_000;
const SPEEDS = [0.5, 1, 2, 4];

const nodeDurationMs = (n: Node): number => {
  const d = n.data ?? {};
  switch (n.type) {
    case 'invocation':
      return d.duration ?? 0;
    case 'event':
      return (d.detectionDuration ?? 0) + (d.handlerDuration ?? 0);
    case 'job':
      return d.duration ?? 0;
    default:
      return 0;
  }
};

export interface FlowPlayback {
  active: boolean;
  playing: boolean;
  /** Position in REAL chain milliseconds (0..total). */
  time: number;
  /** Real chain span in milliseconds. */
  total: number;
  speed: number;
  revealed: Set<string>;
  running: Set<string>;
  totalCount: number;
  hasTimeline: boolean;
  start: () => void;
  exit: () => void;
  togglePlay: () => void;
  seek: (ms: number) => void;
  cycleSpeed: () => void;
}

export const useFlowPlayback = (nodes: Node[]): FlowPlayback => {
  // Per-node [start, end] offsets relative to the earliest created_at. Ghost
  // overlay nodes never happened, so they have no place on the timeline.
  const { offsets, total, totalCount } = useMemo(() => {
    const map = new Map<string, { start: number; end: number }>();
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const n of nodes) {
      if (String(n.id).startsWith('ghost-') || n.data?.ghost) continue;
      const created = n.data?.createdAt ? new Date(n.data.createdAt).getTime() : NaN;
      if (Number.isNaN(created)) continue;
      const end = created + Math.max(nodeDurationMs(n), 0);
      map.set(n.id, { start: created, end });
      if (created < t0) t0 = created;
      if (end > t1) t1 = end;
    }
    for (const [id, t] of map) map.set(id, { start: t.start - t0, end: t.end - t0 });
    return { offsets: map, total: Math.max(t1 - t0, 1), totalCount: map.size };
  }, [nodes]);

  const [active, setActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [time, setTime] = useState(0);
  const lastFrameRef = useRef(0);

  useEffect(() => {
    if (!active || !playing) return;
    let frame: number;
    lastFrameRef.current = performance.now();
    const tick = (now: number) => {
      // Clamp the frame delta: rAF stops while the window is hidden/occluded, so
      // an unclamped delta would skip the replay to the end when the user tabs
      // back. Clamped, a rendering stall behaves like a pause instead.
      const dt = Math.min(now - lastFrameRef.current, 100);
      lastFrameRef.current = now;
      setTime(t => {
        const next = t + dt * speed * (total / BASE_MS);
        if (next >= total) {
          setPlaying(false);
          return total;
        }
        return next;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, playing, speed, total]);

  const { revealed, running } = useMemo(() => {
    const revealedSet = new Set<string>();
    const runningSet = new Set<string>();
    if (active) {
      for (const [id, t] of offsets) {
        if (time >= t.start) {
          revealedSet.add(id);
          if (time < t.end) runningSet.add(id);
        }
      }
    }
    return { revealed: revealedSet, running: runningSet };
  }, [active, time, offsets]);

  const start = useCallback(() => {
    setTime(0);
    setActive(true);
    setPlaying(true);
  }, []);
  const exit = useCallback(() => {
    setActive(false);
    setPlaying(false);
    setTime(0);
  }, []);
  const togglePlay = useCallback(() => {
    setPlaying(p => {
      if (!p && time >= total) setTime(0); // play again from the top when ended
      return !p;
    });
  }, [time, total]);
  const seek = useCallback(
    (ms: number) => setTime(Math.min(Math.max(ms, 0), total)),
    [total]
  );
  const cycleSpeed = useCallback(
    () => setSpeed(s => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]),
    []
  );

  return {
    active,
    playing,
    time,
    total,
    speed,
    revealed,
    running,
    totalCount,
    hasTimeline: totalCount > 0,
    start,
    exit,
    togglePlay,
    seek,
    cycleSpeed,
  };
};

export default useFlowPlayback;
