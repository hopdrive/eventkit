// The plugin manager owns the §11 composition model at runtime:
//  - lazy instantiation of factories (D22) with kit-level context injected at onInit
//  - capability resolution: one `source` (required), at most one `platform`,
//    uniqueness enforced at the role level, `requires` validated (D20)
//  - notification fan-out in registration order, best-effort (a plugin throwing
//    does not fail the invocation — it is routed to onError + framework log)
//  - delta-transform merges (configureInvocation / augmentEnvelope / augmentJobContext)
//  - singleton-capability accessors (normalize / buildDetectorContext /
//    buildHandlerContext; platform extractPayload / buildRequest / formatResponse)
import type {
  Capability,
  CrashPolicy,
  DetectionResult,
  DetectorContext,
  ErrorContext,
  ErrorPhase,
  EventEnvelope,
  EventKitPlugin,
  EventSourceName,
  EventSourceType,
  HandlerContext,
  HandlerLogger,
  HandlerResult,
  InvocationContext,
  InvocationResult,
  JobCheckpoint,
  JobContext,
  JobContextContribution,
  JobExecution,
  JobProgress,
  KitContext,
  LogEntry,
  PluginFactory,
  RequestContext,
} from '../core/index.js';
import { serializeError, isClientError } from '../core/index.js';

interface Registration {
  pluginOrFactory: EventKitPlugin | PluginFactory;
  config: Record<string, unknown>;
}

const isFactory = (x: EventKitPlugin | PluginFactory): x is PluginFactory => typeof x === 'function';

const parseRole = (cap: Capability): string => cap.split(':')[0] ?? cap;

export class PluginManager {
  private readonly registrations: Registration[] = [];
  private plugins: EventKitPlugin[] = [];
  private configByName = new Map<string, Record<string, unknown>>();
  private resolved = false;
  private initialized = false;

  /** Resolved singleton capability providers. */
  source!: EventKitPlugin;
  platform?: EventKitPlugin;

  constructor(source: EventKitPlugin | PluginFactory, sourceConfig: Record<string, unknown>) {
    // The source is registration[0] — first in fan-out order.
    this.registrations.push({ pluginOrFactory: source, config: sourceConfig });
  }

  /** Register a plugin/factory (NOT a call) + optional config; instantiated at resolve (D22). */
  add(pluginOrFactory: EventKitPlugin | PluginFactory, config?: unknown): void {
    if (this.resolved) throw new Error('Cannot register a plugin after the kit has been resolved.');
    this.registrations.push({ pluginOrFactory, config: (config as Record<string, unknown>) ?? {} });
  }

  get pluginsInOrder(): readonly EventKitPlugin[] {
    return this.plugins;
  }

  /**
   * Synchronous validation: instantiate factories (D22 — lazy, here), enforce
   * unique names + capability uniqueness, and validate `requires`. Idempotent.
   * `onInit` (which may be async) runs separately in `runInit`.
   */
  resolve(): void {
    if (this.resolved) return;

    // 1. Instantiate factories (D22 — lazy, here at first resolve).
    this.plugins = this.registrations.map(({ pluginOrFactory, config }) => {
      const plugin = isFactory(pluginOrFactory) ? pluginOrFactory(config) : pluginOrFactory;
      if (!plugin || typeof plugin.name !== 'string') {
        throw new Error('A registered plugin must be an object with a string `name`.');
      }
      this.configByName.set(plugin.name, config);
      return plugin;
    });

    // 2. Duplicate plugin names.
    const names = new Set<string>();
    for (const p of this.plugins) {
      if (names.has(p.name)) throw new Error(`Duplicate plugin name registered: '${p.name}'.`);
      names.add(p.name);
    }

    // 3. Resolve singleton capabilities; enforce role-level uniqueness.
    const providersByRole = new Map<string, EventKitPlugin>();
    const providedTokens = new Set<string>();
    for (const p of this.plugins) {
      for (const cap of p.provides ?? []) {
        providedTokens.add(cap);
        const role = parseRole(cap);
        const existing = providersByRole.get(role);
        if (existing && existing !== p) {
          throw new Error(
            `Two plugins claim the '${role}' capability: '${existing.name}' and '${p.name}'. Exactly one is allowed.`,
          );
        }
        providersByRole.set(role, p);
      }
    }
    const source = providersByRole.get('source');
    if (!source) throw new Error('No source registered. A kit requires exactly one source (createEventKit(source)).');
    this.source = source;
    const platform = providersByRole.get('platform');
    if (platform) this.platform = platform;

    // 4. Validate `requires`. A QUALIFIED requirement ('source:hasura') must be
    // matched by that exact token; a bare requirement ('source') is satisfied by
    // any provider of the role (D20).
    for (const p of this.plugins) {
      for (const req of p.requires ?? []) {
        const isQualified = req.includes(':');
        const satisfied = isQualified ? providedTokens.has(req) : providersByRole.has(parseRole(req));
        if (!satisfied) {
          throw new Error(`Plugin '${p.name}' requires capability '${req}', which no registered plugin provides.`);
        }
      }
    }

    this.resolved = true;
  }

  /** Run each plugin's `onInit` with kit-level context injected (registration order). Idempotent; fatal if it throws. */
  async runInit(kitLogger: HandlerLogger): Promise<void> {
    if (this.initialized) return;
    this.resolve();
    const registeredPlugins = this.plugins.map(p => p.name);
    for (const p of this.plugins) {
      const ctx: KitContext = {
        source: { name: this.source.name as EventSourceName, sourceType: this.sourceType },
        registeredPlugins,
        log: kitLogger,
        config: this.configByName.get(p.name) ?? {},
      };
      if (this.platform) ctx.platform = { name: this.platform.name };
      await p.onInit?.(ctx);
    }
    this.initialized = true;
  }

  get sourceType(): EventSourceType {
    return (this.source as EventKitPlugin & { sourceType?: EventSourceType }).sourceType ?? 'application';
  }

  /**
   * The source's crash policy (ADR-038). Framework default `'ack'` (a processing crash
   * stays a 200, no retry); a source that wants at-least-once retry (webhook) declares
   * `'signalRetry'`. Read off the resolved source plugin, like `sourceType`.
   */
  get crashPolicy(): CrashPolicy {
    return (this.source as EventKitPlugin & { crashPolicy?: CrashPolicy }).crashPolicy ?? 'ack';
  }

  // ── Singleton capabilities ─────────────────────────────────────────────────
  normalize(raw: unknown, request: RequestContext): EventEnvelope {
    if (!this.source.normalize) throw new Error(`Source '${this.source.name}' does not implement normalize().`);
    return this.source.normalize(raw, request);
  }

  buildDetectorContext(envelope: EventEnvelope, base: DetectorContext): DetectorContext {
    const enriched = this.source.buildDetectorContext?.(envelope, base);
    return (enriched as DetectorContext) ?? base;
  }

  buildHandlerContext(envelope: EventEnvelope, base: HandlerContext): HandlerContext {
    const ext = this.source.buildHandlerContext?.(envelope, base);
    return ext ? ({ ...base, ...(ext as Record<string, unknown>) } as HandlerContext) : base;
  }

  // ── Delta transforms (merge base + each plugin partial, registration order) ──
  // Each plugin call is ISOLATED (ADR-033): a throw is routed to `onError` and the
  // pipeline continues with the last-good merged value — one plugin's bug must not
  // sink the whole invocation (same best-effort philosophy as the notification
  // fan-out). A plugin that must fail the request loudly throws a branded
  // `ClientError` instead, which we re-throw so it reaches the pre-dispatch fast-path.
  async configureInvocation(request: RequestContext, envelope: EventEnvelope): Promise<RequestContext> {
    let merged = request;
    for (const p of this.plugins) {
      try {
        const partial = p.configureInvocation?.(merged, envelope);
        if (partial) merged = { ...merged, ...partial };
      } catch (err) {
        if (isClientError(err)) throw err;
        await this.dispatchError(err, 'normalize');
      }
    }
    return merged;
  }

  // Awaitable (ADR-028): `await` tolerates a sync return (loop-guard) and a promise
  // (correlation-resolver's DB lookup) alike. Registration-order folding is preserved
  // — a later plugin sees the merged result of every earlier one, so loop-guard's
  // echo-back extraction runs before the resolver's lookup fallback can fire.
  // `meta` is DEEP-merged one level (ADR-033): a plugin returning `{ meta: { myKey } }`
  // refines meta without wiping a sibling's `sourceTrackingToken`/`sourceJobId`.
  async augmentEnvelope(envelope: EventEnvelope): Promise<EventEnvelope> {
    let merged = envelope;
    for (const p of this.plugins) {
      try {
        const partial = await p.augmentEnvelope?.(merged);
        if (partial) {
          merged = partial.meta
            ? { ...merged, ...partial, meta: { ...merged.meta, ...partial.meta } }
            : { ...merged, ...partial };
        }
      } catch (err) {
        if (isClientError(err)) throw err;
        await this.dispatchError(err, 'normalize');
      }
    }
    return merged;
  }

  /** Collect plugin job-context contributions (ADR-020). Caller merges handler input on top. */
  collectJobContribution(ctx: JobContext): { input: Record<string, unknown>; trackingToken?: string } {
    const input: Record<string, unknown> = {};
    let trackingToken: string | undefined;
    for (const p of this.plugins) {
      const contribution = p.augmentJobContext?.(ctx) as JobContextContribution | void;
      if (!contribution) continue;
      if (contribution.input) Object.assign(input, contribution.input);
      if (contribution.ambient?.trackingToken !== undefined) trackingToken = contribution.ambient.trackingToken;
    }
    return trackingToken !== undefined ? { input, trackingToken } : { input };
  }

  // ── Notifications (best-effort fan-out, registration order) ─────────────────
  private async dispatchError(error: unknown, phase: ErrorPhase, extra: Partial<ErrorContext> = {}): Promise<void> {
    const ctx: ErrorContext = {
      error: serializeError(error),
      phase,
      invocationId: extra.invocationId ?? '',
      correlationId: extra.correlationId ?? '',
    };
    if (extra.eventName !== undefined) ctx.eventName = extra.eventName;
    if (extra.jobName !== undefined) ctx.jobName = extra.jobName;
    for (const p of this.plugins) {
      try {
        await p.onError?.(ctx);
      } catch {
        // an onError handler that throws is swallowed — never let error handling cascade
      }
    }
  }

  private async fanOut(run: (p: EventKitPlugin) => unknown, phase: ErrorPhase): Promise<void> {
    for (const p of this.plugins) {
      try {
        await run(p);
      } catch (err) {
        await this.dispatchError(err, phase);
      }
    }
  }

  onInvocationStart = (ctx: InvocationContext) => this.fanOut(p => p.onInvocationStart?.(ctx), 'plugin');
  onInvocationEnd = (ctx: InvocationContext, result: InvocationResult) =>
    this.fanOut(p => p.onInvocationEnd?.(ctx, result), 'plugin');
  onEventDetectionStart = (ctx: DetectorContext) => this.fanOut(p => p.onEventDetectionStart?.(ctx), 'detect');
  onEventDetectionEnd = (ctx: DetectorContext, result: DetectionResult) =>
    this.fanOut(p => p.onEventDetectionEnd?.(ctx, result), 'detect');
  onEventHandlerStart = (ctx: HandlerContext) => this.fanOut(p => p.onEventHandlerStart?.(ctx), 'handle');
  onEventHandlerEnd = (ctx: HandlerContext, result: HandlerResult) =>
    this.fanOut(p => p.onEventHandlerEnd?.(ctx, result), 'handle');
  onJobStart = (ctx: JobContext) => this.fanOut(p => p.onJobStart?.(ctx), 'job');
  onJobProgress = (ctx: JobContext, progress: JobProgress) => this.fanOut(p => p.onJobProgress?.(ctx, progress), 'job');
  onJobCheckpoint = (ctx: JobContext, checkpoint: JobCheckpoint) =>
    this.fanOut(p => p.onJobCheckpoint?.(ctx, checkpoint), 'job');
  onJobLog = (ctx: JobContext, entry: LogEntry) => this.fanOut(p => p.onJobLog?.(ctx, entry), 'job');
  onJobEnd = (ctx: JobContext, execution: JobExecution) => this.fanOut(p => p.onJobEnd?.(ctx, execution), 'job');
  onLog = (entry: LogEntry) => this.fanOut(p => p.onLog?.(entry), 'plugin');
  onBeforeNormalize = (raw: unknown, request: RequestContext) =>
    this.fanOut(p => p.onBeforeNormalize?.(raw, request), 'normalize');
  onAfterNormalize = (envelope: EventEnvelope) => this.fanOut(p => p.onAfterNormalize?.(envelope), 'normalize');
  onFlush = () => this.fanOut(p => p.onFlush?.(), 'plugin');
  onShutdown = () => this.fanOut(p => p.onShutdown?.(), 'plugin');

  reportError = (error: unknown, phase: ErrorPhase, extra?: Partial<ErrorContext>) =>
    this.dispatchError(error, phase, extra);
}
