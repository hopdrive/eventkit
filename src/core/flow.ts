// =============================================================================
// Flow description + manifest types (§14–§16)
// =============================================================================
// Two related shapes:
//   • KitDescription — the read-only result of introspecting a built kit
//     (`kit.describe()`). A faithful registry walk: source, platform, plugins,
//     and every registered event with its STATIC job set. No execution. This is
//     the "generator verifies structure" half (§15) — it works precisely because
//     modules are declarative (ADR-025: static `jobs`, no conditional inclusion),
//     so the whole structure is knowable without running anything.
//   • FlowManifest / FlowNode / FlowEdge — the RFC's business-process contract
//     vocabulary (§15/§16). A hand-authored manifest owns MEANING; a generated
//     graph (from a KitDescription) proves STRUCTURE. They share this vocabulary
//     so a generated graph can be diffed against — or promoted into — a manifest.

/** How a module produces its synchronous response (ADR-026). */
export type FlowResponseKind = 'none' | 'resolve' | 'respond';

/** One job in a registered event, as seen by introspection (declared options only — never live `input`). */
export interface KitJobDescription {
  name: string;
  retries?: number;
  timeoutMs?: number;
  continueOnFailure?: boolean;
  tags?: string[];
  /** The job's serializable `metadata` (e.g. a declared `sideEffect`), if any. */
  metadata?: Record<string, unknown>;
}

/** One registered event module, flattened to its structural facts. */
export interface KitEventDescription {
  name: string;
  /** `none` (fire-and-forget), `resolve` (job-independent), or `respond` (result-driven). */
  response: FlowResponseKind;
  jobs: KitJobDescription[];
  /** Run mode for the job set, when the module pins one. */
  runMode?: 'parallel' | 'series';
  // ── From the module's registration-time `metadata` (EventModuleMetadata) ──
  description?: string;
  owner?: string;
  tags?: string[];
  deprecated?: boolean;
  flowHints?: Record<string, unknown>;
}

/** The structural snapshot of a built kit — what `kit.describe()` returns. */
export interface KitDescription {
  source: { name: string; type: string };
  platform?: string;
  /** Observer/transform plugins (the source and platform are excluded). */
  plugins: string[];
  events: KitEventDescription[];
}

// ── Manifest vocabulary (§15/§16) ────────────────────────────────────────────

export type FlowNodeKind = 'source' | 'invocation' | 'event' | 'handler' | 'job' | 'sideEffect' | 'terminal';

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  eventName?: string;
  jobName?: string;
  sourceFunction?: string;
  required?: boolean;
  condition?: string;
  metadata?: Record<string, unknown>;
}

export interface FlowEdge {
  from: string;
  to: string;
  required?: boolean;
  condition?: string;
}

export interface FlowSourceRef {
  kind: string;
  trigger?: string;
}

/**
 * A source-controlled business-process contract (§15). Hand-authored manifests
 * own meaning; `toFlowGraph()` emits the `{ nodes, edges }` structural skeleton
 * in this same vocabulary so the two can be reconciled (Compare Mode, §14).
 */
export interface FlowManifest {
  id: string;
  name: string;
  description?: string;
  owner?: string;
  source?: FlowSourceRef;
  nodes: FlowNode[];
  edges: FlowEdge[];
  metadata?: Record<string, unknown>;
}
