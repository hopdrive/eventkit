import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Edge, Node } from 'reactflow';

// Chain replay clock. Every observed node carries created_at (ms precision) and a
// duration, so the run can be replayed: a node is REVEALED when the clock passes
// its start offset and RUNNING until the clock passes its end. Time is measured
// in the run's own milliseconds (scrubber + labels speak real chain time); the
// wall-clock mapping is normalized — 1× plays the WHOLE timeline in BASE_MS
// regardless of real span, because raw wall-clock replay is useless at both
// extremes (a 300ms chain flashes by; a 4-minute chain is unwatchable).
//
// PERF CONTRACT: the clock advances in a ref, NOT React state. An earlier version
// setState'd the time 60×/s, which re-rendered the whole flow page (and rebuilt
// the graph) every frame — starving the very CSS animations (edge dashes, node
// spinners, activity sweeps) the replay exists to show. Now the diagram only
// re-renders when a node crosses a reveal/running boundary; the transport bar
// runs its own tiny rAF ticker to keep the scrubber moving.
const BASE_MS = 10_000;
const SPEEDS = [0.5, 1, 2, 4];
const EMPTY = new Set<string>();

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
  /** Clock position in REAL chain milliseconds (0..total). A ref so per-frame
   *  ticks never re-render the diagram; the transport bar reads it on its own
   *  rAF ticker. */
  timeRef: React.MutableRefObject<number>;
  /** Real chain span in milliseconds. */
  total: number;
  speed: number;
  revealed: Set<string>;
  running: Set<string>;
  /** Subset of `running`: finished executing, but downstream delivery is still
   *  in flight (a chaining job stays busy until its LAST triggered invocation
   *  starts — attribution for the debounce/webhook-delivery gap). */
  waiting: Set<string>;
  totalCount: number;
  hasTimeline: boolean;
  start: () => void;
  exit: () => void;
  togglePlay: () => void;
  seek: (ms: number) => void;
  cycleSpeed: () => void;
}

export const useFlowPlayback = (nodes: Node[], edges: Edge[]): FlowPlayback => {
  // Per-node [start, end, waitEnd] offsets relative to the earliest created_at.
  // `end` is when the node's own execution finished; `waitEnd` extends a chaining
  // job's busy window until the START of the last invocation it triggers — the
  // job's write/webhook is still being delivered (debounce, event queue) during
  // that gap, and it is the node responsible for the reveal that's coming. Ghost
  // overlay nodes never happened, so they have no place on the timeline.
  const { offsets, total, totalCount } = useMemo(() => {
    const map = new Map<string, { start: number; end: number; waitEnd: number }>();
    const typeOf = new Map(nodes.map(n => [n.id, n.type]));
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const n of nodes) {
      if (String(n.id).startsWith('ghost-') || n.data?.ghost) continue;
      const created = n.data?.createdAt ? new Date(n.data.createdAt).getTime() : NaN;
      if (Number.isNaN(created)) continue;
      const end = created + Math.max(nodeDurationMs(n), 0);
      map.set(n.id, { start: created, end, waitEnd: end });
      if (created < t0) t0 = created;
      if (end > t1) t1 = end;
    }
    for (const e of edges) {
      if (String(e.id).startsWith('ghost-')) continue;
      if (typeOf.get(e.source) !== 'job' || typeOf.get(e.target) !== 'invocation') continue;
      const job = map.get(e.source);
      const inv = map.get(e.target);
      if (job && inv && inv.start > job.waitEnd) job.waitEnd = inv.start;
    }
    for (const [id, t] of map) map.set(id, { start: t.start - t0, end: t.end - t0, waitEnd: t.waitEnd - t0 });
    return { offsets: map, total: Math.max(t1 - t0, 1), totalCount: map.size };
  }, [nodes, edges]);

  const [active, setActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const timeRef = useRef(0);
  const [sets, setSets] = useState<{ revealed: Set<string>; running: Set<string>; waiting: Set<string> }>({
    revealed: EMPTY,
    running: EMPTY,
    waiting: EMPTY,
  });

  const computeSets = useCallback(
    (t: number) => {
      const revealed = new Set<string>();
      const running = new Set<string>();
      const waiting = new Set<string>();
      for (const [id, o] of offsets) {
        if (t >= o.start) {
          revealed.add(id);
          if (t < o.end) running.add(id);
          else if (t < o.waitEnd) {
            running.add(id); // busy for indicator purposes…
            waiting.add(id); // …but annotated as delivering, not executing
          }
        }
      }
      return { revealed, running, waiting };
    },
    [offsets]
  );

  // Publish new sets ONLY on a boundary crossing. Size comparison is sound:
  // revealed sets are threshold sets (equal size ⇒ same set of passed starts),
  // and within one revealed window running/waiting membership changes only as
  // fixed end/waitEnd thresholds pass, so equal sizes ⇒ equal sets.
  const syncSets = useCallback(
    (t: number) => {
      const next = computeSets(t);
      setSets(prev =>
        prev.revealed.size === next.revealed.size &&
        prev.running.size === next.running.size &&
        prev.waiting.size === next.waiting.size
          ? prev
          : next
      );
    },
    [computeSets]
  );

  useEffect(() => {
    if (!active || !playing) return;
    let frame: number;
    let last = performance.now();
    const tick = (now: number) => {
      // Clamp the frame delta: rAF stops while the window is hidden/occluded, so
      // an unclamped delta would skip the replay to the end when the user tabs
      // back. Clamped, a rendering stall behaves like a pause instead.
      const dt = Math.min(now - last, 100);
      last = now;
      const next = timeRef.current + dt * speed * (total / BASE_MS);
      if (next >= total) {
        timeRef.current = total;
        syncSets(total);
        setPlaying(false);
        return;
      }
      timeRef.current = next;
      syncSets(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, playing, speed, total, syncSets]);

  const start = useCallback(() => {
    timeRef.current = 0;
    syncSets(0);
    setActive(true);
    setPlaying(true);
  }, [syncSets]);
  const exit = useCallback(() => {
    setActive(false);
    setPlaying(false);
    timeRef.current = 0;
    setSets({ revealed: EMPTY, running: EMPTY, waiting: EMPTY });
  }, []);
  const togglePlay = useCallback(() => {
    setPlaying(p => {
      if (!p && timeRef.current >= total) {
        timeRef.current = 0; // play again from the top when ended
        syncSets(0);
      }
      return !p;
    });
  }, [total, syncSets]);
  const seek = useCallback(
    (ms: number) => {
      timeRef.current = Math.min(Math.max(ms, 0), total);
      syncSets(timeRef.current);
    },
    [total, syncSets]
  );
  const cycleSpeed = useCallback(
    () => setSpeed(s => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]),
    []
  );

  return {
    active,
    playing,
    timeRef,
    total,
    speed,
    revealed: sets.revealed,
    running: sets.running,
    waiting: sets.waiting,
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
