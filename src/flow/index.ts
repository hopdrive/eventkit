// =============================================================================
// eventkit/flow
// =============================================================================
// Flow-documentation generators (§14–§16). Turn a built kit into a structural
// description, a manifest-vocabulary graph, or a committed YAML document. Pure —
// a read-only registry walk, faithful because modules are declarative (ADR-025).
//
// The CLI backend (`./cli`) is deliberately NOT re-exported here: it uses node
// builtins and is loaded only by the `eventkit-flow` bin, so importing this barrel
// stays free of `node:fs`.
export { describeKit, toFlowGraph, toFlowYaml, toFlowMermaid, flowNodeId, type FlowOrigin } from './graph.js';
export { toYaml } from './yaml.js';
export type {
  KitDescription,
  KitEventDescription,
  KitJobDescription,
  FlowResponseKind,
  FlowManifest,
  FlowNode,
  FlowEdge,
  FlowNodeKind,
  FlowSourceRef,
  JobEffect,
} from '../core/index.js';
