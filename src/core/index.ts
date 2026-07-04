// =============================================================================
// eventkit/core — frozen public contracts
// =============================================================================
// The complete public type surface (the §9/§11 RFC interfaces plus the helper
// types the RFC left loose) lives here. Runtime values exported are the pure
// leaf utilities (serialization, branded-id helpers) plus the Phase-0 stubs
// (`job`, `run`, `createEventKit`) whose bodies land in Phase 1.

// ── Branded identifiers ────────────────────────────────────────────────────
export type {
  EventName,
  JobName,
  CorrelationId,
  PluginName,
  InvocationId,
  EventSourceName,
} from './brands.js';
export {
  asEventName,
  asJobName,
  asCorrelationId,
  asPluginName,
  asInvocationId,
  asEventSourceName,
} from './brands.js';

// ── Capabilities (D20) ──────────────────────────────────────────────────────
export type { Capability, CapabilityRole, ParsedCapability } from './capabilities.js';

// ── Source-meta convention (well-known envelope.meta keys) ────────────────────
export type { SourceMeta } from './source-meta.js';
export { SOURCE_META_KEYS } from './source-meta.js';

// ── Tracking-token codec (ADR-039.1: a pure core primitive) ───────────────────
export type { TokenCodec, TokenCodecConfig, TokenComponents } from './tracking-token.js';
export { createTokenCodec, isCorrelationIdShape } from './tracking-token.js';

// ── Loggers ───────────────────────────────────────────────────────────────
export type { LogLevel, LogEntry, DetectorLogger, HandlerLogger, JobLogger } from './logger.js';

// ── Errors + serialization ──────────────────────────────────────────────────
export type { SerializedError, ErrorContext, ErrorPhase, LoopDetectedDetail } from './errors.js';
export { serializeError, serializeOutput, replaceCircularReferences, ClientError, ActionError, isClientError, LoopDetectedError, isLoopDetectedError } from './errors.js';
export type { SuppressDispatch, ChainGuardWarning } from './chain-guard.js';
export { SUPPRESS_DISPATCH_KEY, CHAIN_GUARD_WARNING_KEY } from './chain-guard.js';
export { getNonSerializableLabel, stripNonSerializable, assertSerializableMetadata, NonSerializableMetadataError } from './serialize.js';

// ── Envelope + detected event ────────────────────────────────────────────────
export type { EventSourceType, EventEnvelope, DetectedEvent } from './envelope.js';

// ── Contexts ────────────────────────────────────────────────────────────────
export type {
  DetectorContext,
  HandlerContext,
  RequestContext,
  InvocationContext,
  KitContext,
  KitPrepareContext,
  KitPrepareFunction,
} from './context.js';

// ── Jobs ──────────────────────────────────────────────────────────────────
export type {
  JobOptions,
  JobFunction,
  JobDefinition,
  JobContext,
  JobInputContext,
  JobContextContribution,
  JobProgress,
  JobCheckpoint,
  JobExecution,
  JobExecutionStatus,
  JobsResult,
  RunOptions,
} from './job.js';
export { job, NotImplementedError } from './job.js';

// ── Event modules (ADR-025: declarative; no handler) ─────────────────────────
export type {
  EventModule,
  EventModuleMetadata,
  DetectorFunction,
  PrepareFunction,
  ResolveFunction,
  RespondFunction,
} from './event-module.js';
export { defineEvent } from './event-module.js';

// ── Plugin contracts ─────────────────────────────────────────────────────────
export type {
  EventKitPlugin,
  SourceAdapter,
  PlatformAdapter,
  CrashPolicy,
  DetectionResult,
  HandlerResult,
  NormalizeFn,
  FormatFn,
} from './plugin.js';

// ── Kit / entry point (types only; createEventKit + run are runtime, re-exported from the root) ──
export type { EventKit, InvocationResult, EventOutcome, ResolvedOutcome, ResolvedError, PluginFactory, HandlerShortCircuit, HttpRequestEvent, DryRunResult, DryRunEvent } from './kit.js';

// ── Flow description + manifest vocabulary (§14–§16) ─────────────────────────
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
} from './flow.js';
