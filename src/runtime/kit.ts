// createEventKit() + the EventKit implementation. Built once at module scope and
// reused across warm invocations; per-request data flows through handle()
// (ADR-013). The lifecycle (§6): normalize → augment → detect → handle → finalize,
// all run inside the AsyncLocalStorage invocation store so the free run() reaches
// invocation-scoped state.
import {
  asEventName,
  asInvocationId,
  serializeError,
  type DetectedEvent,
  type DetectionResult,
  type DetectorContext,
  type EventEnvelope,
  type EventKit,
  type EventKitPlugin,
  type EventModule,
  type EventOutcome,
  type EventSourceName,
  type EventSourceType,
  type HandlerContext,
  type HandlerResult,
  type HandlerShortCircuit,
  type InvocationContext,
  type InvocationResult,
  type JobExecution,
  type PluginFactory,
  type RequestContext,
  type SerializedError,
} from '../core/index.js';
import { PluginManager } from './plugin-manager.js';
import { invocationStore, type InvocationRuntime } from './invocation-store.js';
import { createHandlerLogger, createDetectorLogger } from './loggers.js';
import { newInvocationId, newCorrelationId, newUuid } from './ids.js';

/** Milliseconds reserved before the serverless budget expires, for best-effort flush. */
const FLUSH_SAFETY_MARGIN_MS = 200;

class Kit implements EventKit {
  private readonly pm: PluginManager;
  private readonly modules: EventModule[] = [];
  private readonly moduleNames = new Set<string>();
  private validated = false;
  private readyPromise?: Promise<void>;

  constructor(source: EventKitPlugin | PluginFactory, config?: unknown) {
    this.pm = new PluginManager(source, (config as Record<string, unknown>) ?? {});
  }

  use(plugin: EventKitPlugin | PluginFactory, config?: unknown): EventKit {
    this.pm.add(plugin, config);
    return this;
  }

  registerEvent(module: EventModule): EventKit {
    if (!module || typeof module.name !== 'string') throw new Error('registerEvent: module must have a string name.');
    if (typeof module.detector !== 'function') throw new Error(`Event '${module.name}' is missing a detector.`);
    if (typeof module.handler !== 'function') throw new Error(`Event '${module.name}' is missing a handler.`);
    if (this.moduleNames.has(module.name)) throw new Error(`Duplicate event name registered: '${module.name}'.`);
    this.moduleNames.add(module.name);
    this.modules.push(module);
    return this;
  }

  registerEvents(modules: EventModule[] | Record<string, EventModule>): EventKit {
    const list = Array.isArray(modules) ? modules : Object.values(modules);
    for (const m of list) this.registerEvent(m);
    return this;
  }

  validate(): void {
    // Synchronous checks: plugin instantiation + capability/requires resolution,
    // plus registration sanity. onInit (async) runs in ensureReady()/handle().
    this.pm.resolve();
    if (this.modules.length === 0) throw new Error('No event modules registered. Call kit.registerEvents(...).');
    this.validated = true;
  }

  private kitLogger() {
    return createHandlerLogger({ scope: 'eventkit' }, entry => void this.pm.onLog(entry));
  }

  private ensureReady(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        if (!this.validated) this.validate();
        await this.pm.runInit(this.kitLogger());
        this.warnIfMissingPlatform();
      })();
    }
    return this.readyPromise;
  }

  // Detect-and-warn (ADR-021): if a deadline-capable runtime is detected but no
  // platform adapter is registered, the time budget / cancellation / pre-kill flush
  // silently won't work. Surface that once at init rather than leaving it a footgun.
  private warnIfMissingPlatform(): void {
    if (this.pm.platform) return;
    const e = typeof process !== 'undefined' && process.env ? process.env : {};
    const detected = e['AWS_LAMBDA_FUNCTION_NAME']
      ? 'AWS Lambda'
      : e['NETLIFY']
        ? 'Netlify'
        : e['VERCEL']
          ? 'Vercel'
          : null;
    if (detected) {
      // eslint-disable-next-line no-console
      console.warn(
        `[eventkit] A deadline-capable platform (${detected}) was detected but no platform adapter is registered. ` +
          `Time-budget cancellation and best-effort flush are disabled. Register one, e.g. kit.use(netlifyPlatform).`,
      );
    }
  }

  handler(opts?: {
    before?: (...args: unknown[]) => HandlerShortCircuit | void | Promise<HandlerShortCircuit | void>;
  }): (...args: unknown[]) => unknown {
    return async (...args: unknown[]) => {
      // Resolve the kit (and thus the platform) up front so a `before` rejection can
      // be shaped by the platform even though it never reaches handle().
      await this.ensureReady();
      if (opts?.before) {
        const pre = await opts.before(...args);
        if (pre != null) {
          // Route the pre-handle rejection through the platform so it is shaped
          // correctly for the runtime (e.g. {statusCode,body} classic vs a Web
          // Response on v2) — the pre-check stays platform-agnostic.
          return this.pm.platform?.formatRejection ? this.pm.platform.formatRejection(pre) : pre;
        }
      }
      const result = await this.handle(args[0], args[1]);
      return this.pm.platform ? this.pm.platform.formatResponse?.(result) : result;
    };
  }

  async handle(rawPayloadOrArgs: unknown, request?: RequestContext | unknown): Promise<InvocationResult> {
    await this.ensureReady();
    const startedAt = new Date();
    const start = Date.now();
    const fallbackId = newInvocationId();
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;

    // A framework-level failure (normalize/extractPayload/etc.) produces a fatal
    // InvocationResult with a top-level `error` → 500 → the platform/Hasura MAY
    // retry. Business-logic crashes (detector/handler/job) are caught downstream
    // and stay in events[] with NO top-level error → 200 → no retry.
    try {
    // 1. Resolve raw payload + RequestContext (platform-aware).
    let raw: unknown;
    let req: RequestContext;
    if (this.pm.platform) {
      raw = await this.pm.platform.extractPayload?.(rawPayloadOrArgs, request);
      req = (this.pm.platform.buildRequest?.(rawPayloadOrArgs, request) as RequestContext) ?? {};
    } else {
      raw = rawPayloadOrArgs;
      req = (request as RequestContext) ?? {};
    }

    const source = this.pm.source.name as EventSourceName;
    const sourceType: EventSourceType = this.pm.sourceType;

    // 2. Normalize → augment envelope.
    await this.pm.onBeforeNormalize(raw, req);
    let envelope: EventEnvelope = this.pm.normalize(raw, req);
    envelope = this.pm.augmentEnvelope(envelope);
    await this.pm.onAfterNormalize(envelope);

    // 3. Per-request config refinement (delta), then resolve ids.
    req = this.pm.configureInvocation(req, envelope);
    const invocationId = req.invocationId ? asInvocationId(req.invocationId) : newInvocationId();
    // Single correlationId lever, by precedence: a plugin's augmentEnvelope (e.g.
    // loop-prevention lifting the inbound token's correlation — chaining beats a
    // fresh id, ran above) > the source's normalize (which already folded in
    // request.correlationId ?? trace_context ?? generated) > a defensive fallback.
    const correlationId = envelope.correlationId ?? newCorrelationId();

    // 4. Time budget → AbortSignal (best-effort flush margin).
    const controller = new AbortController();
    let timedOut = false;
    if (req.getRemainingTimeMs) {
      const budget = req.getRemainingTimeMs() - FLUSH_SAFETY_MARGIN_MS;
      if (budget > 0) {
        budgetTimer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, budget);
        if (typeof budgetTimer.unref === 'function') budgetTimer.unref();
      } else {
        timedOut = true;
        controller.abort();
      }
    }

    const invocation: InvocationContext = {
      invocationId,
      correlationId,
      source,
      sourceType,
      envelope,
      request: req,
      startedAt,
      signal: controller.signal,
      log: createHandlerLogger({ invocationId, correlationId, scope: 'invocation' }, entry => void this.pm.onLog(entry)),
    };
    if (req.sourceFunction !== undefined) invocation.sourceFunction = req.sourceFunction;

    const runtime: InvocationRuntime = { pluginManager: this.pm, invocation, signal: controller.signal };

    const result = await invocationStore.run(runtime, async () => {
      await this.pm.onInvocationStart(invocation);

      const detected = await this.detect(envelope, invocation);
      const events = await this.dispatch(detected, envelope, invocation);

      const res: InvocationResult = {
        ok: events.every(e => e.jobs.every(j => j.status === 'completed' || j.status === 'skipped')),
        invocationId,
        events,
        durationMs: Date.now() - start,
      };
      if (timedOut) res.timedOut = true;

      await this.pm.onInvocationEnd(invocation, res);
      await this.pm.onFlush();
      return res;
    });

    return result;
    } catch (err) {
      await this.pm.reportError(err, 'normalize', { invocationId: fallbackId });
      return { ok: false, invocationId: fallbackId, events: [], durationMs: Date.now() - start, error: serializeError(err) };
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
    }
  }

  /**
   * Run every registered detector. Returns one entry per module that DETECTED
   * (with its DetectedEvent) or whose detector THREW (with the error) — clean
   * `false` verdicts produce no entry. Surfacing detector crashes here lets them
   * appear in InvocationResult.events for observability parity with legacy.
   */
  private async detect(
    envelope: EventEnvelope,
    invocation: InvocationContext,
  ): Promise<Array<{ module: EventModule; event: DetectedEvent | null; error?: SerializedError }>> {
    const out: Array<{ module: EventModule; event: DetectedEvent | null; error?: SerializedError }> = [];
    for (const module of this.modules) {
      const base: DetectorContext = {
        eventName: asEventName(module.name),
        invocationId: invocation.invocationId,
        correlationId: invocation.correlationId,
        envelope,
        source: invocation.source,
        sourceType: invocation.sourceType,
        log: createDetectorLogger(
          { invocationId: invocation.invocationId, correlationId: invocation.correlationId, eventName: asEventName(module.name), scope: 'detection' },
          entry => void this.pm.onLog(entry),
        ),
        metadata: {},
      };
      const ctx = this.pm.buildDetectorContext(envelope, base);

      await this.pm.onEventDetectionStart(ctx);
      const detectStart = Date.now();
      let detected = false;
      let error: ReturnType<typeof serializeError> | undefined;
      try {
        detected = (await module.detector(ctx)) === true;
      } catch (err) {
        error = serializeError(err);
        await this.pm.reportError(err, 'detect', {
          invocationId: invocation.invocationId,
          correlationId: invocation.correlationId,
          eventName: asEventName(module.name),
        });
      }
      const durationMs = Date.now() - detectStart;

      const detectionResult: DetectionResult = { eventName: asEventName(module.name), detected, durationMs };
      if (error !== undefined) detectionResult.error = error;
      await this.pm.onEventDetectionEnd(ctx, detectionResult);

      if (detected) {
        // Concise lifecycle parity: one info line per detected event (the executor
        // logs the per-job + completed lines). Non-detections stay in the obs DB only.
        createHandlerLogger(
          { invocationId: invocation.invocationId, correlationId: invocation.correlationId, eventName: asEventName(module.name), scope: 'detection' },
          entry => void this.pm.onLog(entry),
        ).info(`${module.name} ⭐ detected`, { durationMs });
        out.push({
          module,
          event: {
            id: newUuid(),
            name: asEventName(module.name),
            invocationId: invocation.invocationId,
            correlationId: invocation.correlationId,
            source: invocation.source,
            sourceType: invocation.sourceType,
            detectedAt: new Date(),
            detectorDurationMs: durationMs,
            envelope,
          },
        });
      } else if (error !== undefined) {
        // Detector threw: surface it (detected:false) without firing a handler.
        out.push({ module, event: null, error });
      }
    }
    return out;
  }

  /** Invoke each detected event's handler; collect job executions and surface crashes. */
  private async dispatch(
    detected: Array<{ module: EventModule; event: DetectedEvent | null; error?: SerializedError }>,
    envelope: EventEnvelope,
    invocation: InvocationContext,
  ): Promise<EventOutcome[]> {
    const events: EventOutcome[] = [];
    for (const entry of detected) {
      const { module, event } = entry;

      // Detector crash: report it (detected:false, no jobs); no handler runs.
      if (!event) {
        const crashed: EventOutcome = { name: module.name, detected: false, jobs: [] };
        if (entry.error !== undefined) crashed.error = entry.error;
        events.push(crashed);
        continue;
      }

      const base: HandlerContext = {
        invocationId: invocation.invocationId,
        correlationId: invocation.correlationId,
        event,
        envelope,
        source: invocation.source,
        sourceType: invocation.sourceType,
        log: createHandlerLogger(
          { invocationId: invocation.invocationId, correlationId: invocation.correlationId, eventName: event.name, scope: module.name },
          entry => void this.pm.onLog(entry),
        ),
        metadata: {},
        signal: invocation.signal,
      };
      const ctx = this.pm.buildHandlerContext(envelope, base);

      await this.pm.onEventHandlerStart(ctx);
      const handlerStart = Date.now();
      let jobs: JobExecution[] = [];
      let error: ReturnType<typeof serializeError> | undefined;
      try {
        const res = await module.handler(event, ctx);
        if (Array.isArray(res)) jobs = res;
      } catch (err) {
        error = serializeError(err);
        await this.pm.reportError(err, 'handle', {
          invocationId: invocation.invocationId,
          correlationId: invocation.correlationId,
          eventName: event.name,
        });
      }
      const durationMs = Date.now() - handlerStart;

      const handlerResult: HandlerResult = { eventName: event.name, jobs, durationMs };
      if (error !== undefined) handlerResult.error = error;
      await this.pm.onEventHandlerEnd(ctx, handlerResult);

      // detected stays true even on a handler crash (the event WAS detected); the
      // error is surfaced separately. `ok` is computed from job status only, so a
      // handler crash with no jobs does not flip it — preserving the no-retry contract.
      const outcome: EventOutcome = { name: event.name, detected: true, jobs };
      if (error !== undefined) outcome.error = error;
      events.push(outcome);
    }
    return events;
  }

  async shutdown(): Promise<void> {
    await this.pm.onFlush();
    await this.pm.onShutdown();
  }
}

/**
 * Construct a kit once at module scope with its single required source (the first
 * positional arg — ADR-019). Everything else registers via `kit.use(plugin, config?)`.
 */
export function createEventKit(source: EventKitPlugin | PluginFactory, config?: unknown): EventKit {
  return new Kit(source, config);
}
