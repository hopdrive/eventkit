// createEventKit() + the EventKit implementation. Built once at module scope and
// reused across warm invocations; per-request data flows through handle()
// (ADR-013). The lifecycle (§6): normalize → augment → detect → dispatch → finalize.
// Modules are declarative (ADR-025): dispatch runs each detected event's `prepare`
// once, then hands its static `jobs` array to the runtime executor directly — no
// AsyncLocalStorage reach-around (the executor receives the invocation runtime).
import {
  asEventName,
  asInvocationId,
  isClientError,
  job,
  serializeError,
  SUPPRESS_DISPATCH_KEY,
  CHAIN_GUARD_WARNING_KEY,
  type ChainGuardWarning,
  type SuppressDispatch,
  type DetectedEvent,
  type DetectionResult,
  type DetectorContext,
  type DryRunResult,
  type EventEnvelope,
  type EventKit,
  type EventKitPlugin,
  type EventModule,
  type EventName,
  type EventModuleMetadata,
  type EventOutcome,
  type EventSourceType,
  type FlowResponseKind,
  type JobDefinition,
  type KitDescription,
  type KitEventDescription,
  type KitJobDescription,
  type HandlerContext,
  type HandlerResult,
  type HandlerShortCircuit,
  type InvocationContext,
  type InvocationResult,
  type JobExecution,
  type JobInputContext,
  type KitPrepareContext,
  type KitPrepareFunction,
  type PluginFactory,
  type RequestContext,
  type ResolvedError,
  type ResolvedOutcome,
  type SerializedError,
} from '../core/index.js';
import { isJobDefinition } from '../core/job.js';
import { PluginManager } from './plugin-manager.js';
import { runJobs, type InvocationRuntime } from './run.js';
import { createHandlerLogger, createDetectorLogger } from './loggers.js';
import { newInvocationId, newCorrelationId, newUuid } from './ids.js';

/**
 * Map a thrown value from `resolve`/`prepare` into the platform-mappable shape. Reads
 * `ClientError.status` and `ActionError.code`/`extensions` DUCK-TYPED — `instanceof`
 * across bundled copies of the package is unreliable, and the error classes carry these
 * as plain fields for exactly this reason (ADR-026).
 */
function toResolvedError(err: unknown): ResolvedError {
  const e = (err ?? {}) as { message?: unknown; status?: unknown; code?: unknown; extensions?: unknown };
  const out: ResolvedError = { message: typeof e.message === 'string' ? e.message : String(err) };
  if (typeof e.status === 'number') out.status = e.status;
  if (typeof e.code === 'string') out.code = e.code;
  if (e.extensions && typeof e.extensions === 'object') out.extensions = e.extensions as Record<string, unknown>;
  return out;
}

/** Milliseconds reserved before the serverless budget expires, for best-effort flush. */
const FLUSH_SAFETY_MARGIN_MS = 200;

class Kit implements EventKit {
  private readonly pm: PluginManager;
  private readonly modules: EventModule[] = [];
  private readonly moduleNames = new Set<string>();
  private validated = false;
  private readyPromise?: Promise<void>;
  private readonly kitPrepare: KitPrepareFunction | undefined;

  constructor(source: EventKitPlugin | PluginFactory, config?: unknown) {
    // `prepare` is a RESERVED kit-level key on the config object: a once-per-invocation
    // context provider (createEventKit(source, { prepare })). Peel it off so it never
    // reaches the source plugin's own config, and store it for runKitPrepare().
    const cfg = (config as Record<string, unknown>) ?? {};
    const { prepare, ...sourceConfig } = cfg;
    if (prepare !== undefined && typeof prepare !== 'function') {
      throw new Error('createEventKit: `prepare` must be a function if provided.');
    }
    this.kitPrepare = prepare as KitPrepareFunction | undefined;
    this.pm = new PluginManager(source, sourceConfig);
  }

  /**
   * Run the kit-level `prepare` ONCE for this invocation (after normalize, before
   * detection). Its result becomes `ctx.provided` on every detector, module `prepare`,
   * and job. Returns `{}` when no kit `prepare` is configured.
   */
  private async runKitPrepare(invocation: InvocationContext): Promise<Record<string, unknown>> {
    if (!this.kitPrepare) return {};
    const base: KitPrepareContext = {
      invocationId: invocation.invocationId,
      correlationId: invocation.correlationId,
      envelope: invocation.envelope,
      source: invocation.source,
      sourceType: invocation.sourceType,
      log: invocation.log,
      signal: invocation.signal,
    };
    return (await this.kitPrepare(base)) ?? {};
  }

  use(plugin: EventKitPlugin | PluginFactory, config?: unknown): EventKit {
    this.pm.add(plugin, config);
    return this;
  }

  /**
   * Shared inbound pipeline for `handle()` and `dryRun()`: resolve the raw payload +
   * RequestContext (platform-aware, else pass-through), then normalize → augment →
   * notify. Everything after this point works from the returned envelope.
   */
  private async intake(
    rawPayloadOrArgs: unknown,
    request?: RequestContext | unknown,
  ): Promise<{ envelope: EventEnvelope; req: RequestContext }> {
    let raw: unknown;
    let req: RequestContext;
    if (this.pm.platform) {
      raw = await this.pm.platform.extractPayload?.(rawPayloadOrArgs, request);
      req = (this.pm.platform.buildRequest?.(rawPayloadOrArgs, request) as RequestContext) ?? {};
    } else {
      raw = rawPayloadOrArgs;
      req = (request as RequestContext) ?? {};
    }
    await this.pm.onBeforeNormalize(raw, req);
    let envelope: EventEnvelope = this.pm.normalize(raw, req);
    envelope = await this.pm.augmentEnvelope(envelope);
    await this.pm.onAfterNormalize(envelope);
    return { envelope, req };
  }

  registerEvent(module: EventModule<any, any, any>): EventKit {
    if (!module || typeof module.name !== 'string') throw new Error('registerEvent: module must have a string name.');
    if (typeof module.detector !== 'function') throw new Error(`Event '${module.name}' is missing a detector.`);
    if (module.prepare !== undefined && typeof module.prepare !== 'function') {
      throw new Error(`Event '${module.name}': prepare must be a function if provided.`);
    }
    if (module.resolve !== undefined && typeof module.resolve !== 'function') {
      throw new Error(`Event '${module.name}': resolve must be a function if provided.`);
    }
    if (module.respond !== undefined && typeof module.respond !== 'function') {
      throw new Error(`Event '${module.name}': respond must be a function if provided.`);
    }
    // ADR-026: a module picks ONE response timing. `resolve` runs concurrently with the
    // jobs (sibling-ignorant); `respond` runs after they settle and reads their results.
    if (module.resolve !== undefined && module.respond !== undefined) {
      throw new Error(`Event '${module.name}': declare 'resolve' OR 'respond', not both — they are two response timings for the same seam.`);
    }
    // `respond` composes the response FROM job results, so it needs jobs to read.
    if (module.respond !== undefined && (module.jobs === undefined || module.jobs.length === 0)) {
      throw new Error(`Event '${module.name}': 'respond' requires at least one job (it reads their results); use 'resolve' for a job-independent response.`);
    }
    // ADR-025/026: a module declares `jobs` (fire-and-forget) and/or a response seam
    // (`resolve`/`respond`). A module with neither does nothing — a config error.
    if (module.jobs === undefined && module.resolve === undefined && module.respond === undefined) {
      throw new Error(`Event '${module.name}': must declare 'jobs' and/or 'resolve'/'respond' (a module with neither does nothing).`);
    }
    // ADR-031: series execution and continueOnFailure are specified but NOT enabled in this
    // release. The option types omit them, so a TS caller can't set them; this guards untyped
    // JS callers so a stray `run.mode: 'series'` / `continueOnFailure` fails loud instead of
    // silently downgrading to parallel. (Jobs always run parallel + isolated — ADR-014.)
    const adr031 = `Event '${module.name}': series execution / continueOnFailure is not available in this release (ADR-031).`;
    const run = module.run as { mode?: unknown; continueOnFailure?: unknown } | undefined;
    if (run && ((run.mode !== undefined && run.mode !== 'parallel') || run.continueOnFailure !== undefined)) {
      throw new Error(adr031);
    }
    // `jobs`, if present, is a static array. Each entry is a branded job(...) OR a bare
    // job function (auto-wrapped with `job(fn)` — ADR-025 amendment). Normalize at REGISTER
    // time so the runtime always sees JobDefinitions. A non-job, non-function entry (a
    // look-alike object, a `false` from `cond && job()`/`cond && fn`, `null`) is a config
    // error — conditional inclusion stays impossible.
    let normalizedJobs: typeof this.modules[number]['jobs'];
    if (module.jobs !== undefined) {
      if (!Array.isArray(module.jobs)) {
        throw new Error(`Event '${module.name}': jobs must be a static array of job(fn) entries or bare job functions (ADR-025).`);
      }
      normalizedJobs = module.jobs.map((entry, i) => {
        if (isJobDefinition(entry)) {
          const def = entry as ReturnType<typeof job>;
          if ((def.options as { continueOnFailure?: unknown }).continueOnFailure !== undefined) throw new Error(adr031);
          return def;
        }
        if (typeof entry === 'function') return job(entry as Parameters<typeof job>[0]); // bare fn → job(fn), no options
        throw new Error(
          `Event '${module.name}': jobs[${i}] is not a job(fn) or a job function (ADR-025). ` +
            `Put conditions in the detector (a named event) or inside a job, never at the array level.`,
        );
      });
    }
    if (this.moduleNames.has(module.name)) throw new Error(`Duplicate event name registered: '${module.name}'.`);
    this.moduleNames.add(module.name);
    // Store a module with the normalized (fully-wrapped) jobs so dispatch/runJobs see only JobDefinitions.
    this.modules.push(normalizedJobs ? { ...module, jobs: normalizedJobs } : module);
    return this;
  }

  registerEvents(modules: EventModule<any, any, any>[] | Record<string, EventModule<any, any, any>>): EventKit {
    const list = Array.isArray(modules) ? modules : Object.values(modules);
    for (const m of list) this.registerEvent(m);
    return this;
  }

  validate(): void {
    // Synchronous checks: plugin instantiation + capability/requires resolution,
    // plus registration sanity. onInit (async) runs in ensureReady()/handle().
    this.pm.resolve();
    if (this.modules.length === 0) throw new Error('No event modules registered. Call kit.registerEvents(...).');
    // ADR-026: a result-driven `respond` cannot run under a platform that answers before
    // the jobs finish (a background / 202-early adapter) — the outcome it reads hasn't
    // happened yet. Reject the combination up front rather than silently dropping the body.
    if (this.pm.platform?.deferredResponse) {
      const offender = this.modules.find(m => m.respond !== undefined);
      if (offender) {
        throw new Error(
          `Event '${offender.name}': 'respond' (result-driven response) is incompatible with platform ` +
          `'${this.pm.platform.name}', which responds before jobs finish. Use 'resolve' for an immediate ` +
          `ack, or register a non-deferred platform.`,
        );
      }
    }
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
    // Declared out here so the `finally` can flush regardless of which path we exit by
    // (ADR-033): a pre-dispatch throw must still flush the observability buffer.
    let invocation: InvocationContext | undefined;
    let result: InvocationResult | undefined;
    let flushed = false;

    // A framework-level failure (normalize/extractPayload/etc.) produces a fatal
    // InvocationResult with a top-level `error` → 500 → the platform/Hasura MAY
    // retry. Business-logic crashes (detector/handler/job) are caught downstream
    // and stay in events[] with NO top-level error → 200 → no retry.
    try {
    // 1–2. Resolve raw payload + RequestContext, normalize → augment (shared intake).
    const intake = await this.intake(rawPayloadOrArgs, request);
    const envelope: EventEnvelope = intake.envelope;

    const sourceType: EventSourceType = this.pm.sourceType;

    // 3. Per-request config refinement (delta), then resolve ids.
    const req = await this.pm.configureInvocation(intake.req, envelope);
    const invocationId = req.invocationId ? asInvocationId(req.invocationId) : newInvocationId();
    // Single correlationId lever, by precedence: a plugin's augmentEnvelope (e.g.
    // loop-guard lifting the inbound token's correlation — chaining beats a
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

    invocation = {
      invocationId,
      correlationId,
      // The recorded source is the NORMALIZED envelope's source (the meaningful
      // "what came in" identity, e.g. 'hasura' / 'webhook:stripe'), NOT the plugin's
      // registration `name` (which is folder-aligned, e.g. 'source-hasura-event').
      source: envelope.source,
      sourceType,
      envelope,
      request: req,
      startedAt,
      signal: controller.signal,
      log: createHandlerLogger({ invocationId, correlationId, scope: 'invocation' }, entry => void this.pm.onLog(entry)),
      provided: {},
    };
    if (req.sourceFunction !== undefined) invocation.sourceFunction = req.sourceFunction;

    const runtime: InvocationRuntime = { pluginManager: this.pm, invocation, signal: controller.signal };

    await this.pm.onInvocationStart(invocation);

    // Chain-guard suppress seam (ADR-034 / ADR-041): a pre-dispatch plugin (e.g. loopGuard at
    // its hop-depth ceiling) may set `envelope.meta[SUPPRESS_DISPATCH_KEY]` — either a bare
    // reason string (generic plugin) or a structured `SuppressDispatch { reason, error }` — to
    // hard-stop this invocation before any detector runs. We log it, report the (typically
    // branded LoopDetectedError) through onError with phase 'chain-guard', and return a clean
    // empty result. HTTP stays 200 (never invite a retry of a loop). The finally still records
    // + flushes, so a halted chain is queryable in observability, not a benign no-op.
    const meta = envelope.meta as
      | { suppressDispatch?: unknown; chainGuardWarning?: unknown }
      | undefined;
    const suppress = meta?.[SUPPRESS_DISPATCH_KEY];
    if (typeof suppress === 'string' ? suppress.length > 0 : suppress != null) {
      const sd: SuppressDispatch =
        typeof suppress === 'string' ? { reason: suppress } : (suppress as SuppressDispatch);
      const reason = sd.reason;
      const err = sd.error ?? new Error(reason);
      invocation.log.warn('Dispatch suppressed before detection', { reason });
      await this.pm.reportError(err, 'chain-guard', { invocationId, correlationId });
      result = { ok: true, invocationId, events: [], durationMs: Date.now() - start };
      return result;
    }

    // Non-fatal early alarm (ADR-041 warnAtDepth): a pre-dispatch plugin set a branded error
    // on `meta[CHAIN_GUARD_WARNING_KEY]` to report while dispatch PROCEEDS. Route it through
    // onError at severity 'warn' so alerting fires early, then continue normally.
    const warning = meta?.[CHAIN_GUARD_WARNING_KEY];
    if (warning != null && typeof warning === 'object' && 'error' in warning) {
      await this.pm.reportError((warning as ChainGuardWarning).error, 'chain-guard', {
        invocationId,
        correlationId,
        severity: 'warn',
      });
    }

    // Kit-level prepare (once per invocation, before detection). Its output rides on
    // `ctx.provided` for every detector, module `prepare`, and job. A failure here aborts
    // the invocation cleanly (reported as phase 'prepare'); the `finally` still records + flushes.
    try {
      invocation.provided = await this.runKitPrepare(invocation);
    } catch (err) {
      await this.pm.reportError(err, 'prepare', { invocationId, correlationId });
      invocation.log.error('Kit prepare failed; invocation aborted', {
        error: err instanceof Error ? err.message : String(err),
      });
      result = { ok: false, invocationId, events: [], durationMs: Date.now() - start, error: serializeError(err) };
      return result;
    }

    const detected = await this.detect(envelope, invocation);
    const { events, resolved } = await this.dispatch(detected, envelope, invocation, runtime);

    result = {
      ok: events.every(e => e.jobs.every(j => j.status === 'completed' || j.status === 'skipped')),
      invocationId,
      events,
      durationMs: Date.now() - start,
    };
    if (timedOut) result.timedOut = true;
    if (resolved) result.resolved = resolved;

    // ADR-038: under crashPolicy 'signalRetry' (the webhook source's default), an
    // UNHANDLED processing crash — a detector or prepare throw, surfaced as
    // events[].error — is escalated to a top-level framework error → 500 → an
    // at-least-once sender retries. A deliberate resolve/respond reply (`resolved`)
    // wins: that response is intentional, not a crash. Emit a loud error log too, so a
    // crash this severe is visible in Grafana (the obs sink) on top of the onError
    // route (Sentry) that reportError already fired during detect/dispatch.
    if (this.pm.crashPolicy === 'signalRetry' && !resolved) {
      const crashed = events.find(e => e.error !== undefined);
      if (crashed?.error) {
        invocation.log.error('Processing crash escalated to a retryable 500 (crashPolicy=signalRetry)', {
          event: crashed.name,
          detected: crashed.detected,
          error: crashed.error.message,
        });
        result.error = crashed.error;
        result.ok = false;
      }
    }

    return result;
    } catch (err) {
      // A source may reject a request in the PRE-DISPATCH phase with a client error —
      // e.g. webhook `rejectUnverified` throws ClientError(401) from normalize (ADR-030).
      // Brand-check (ADR-033): ONLY an intentional, branded ClientError maps to that wire
      // status via resolved.error — NOT the framework-500 path — and skips the run. Any
      // OTHER pre-dispatch error (even one that happens to carry a numeric `.status`, e.g.
      // a resolver DB blip) falls through to the framework 500 so the vendor retries,
      // never a silent `{ ok: true }`. No Invocation record: it never became a valid event.
      if (isClientError(err)) {
        this.kitLogger().warn('Request rejected before dispatch (client error)', {
          status: err.status,
          message: String((err as { message?: unknown }).message ?? ''),
        });
        result = {
          ok: true,
          invocationId: fallbackId,
          events: [],
          durationMs: Date.now() - start,
          resolved: { hasResolved: true, error: toResolvedError(err) },
        };
        return result;
      }
      await this.pm.reportError(err, 'normalize', { invocationId: fallbackId });
      result = { ok: false, invocationId: fallbackId, events: [], durationMs: Date.now() - start, error: serializeError(err) };
      return result;
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
      // ALWAYS flush (ADR-033): record the invocation (only when one was built — a
      // pre-dispatch reject has none) and flush the observability buffer exactly once,
      // so a warm-lambda buffer never leaks. Best-effort: never mask the real outcome.
      if (!flushed) {
        flushed = true;
        try {
          if (invocation && result) await this.pm.onInvocationEnd(invocation, result);
          await this.pm.onFlush();
        } catch {
          // onInvocationEnd/onFlush are best-effort fan-outs (they already swallow
          // per-plugin throws); this guard covers anything unexpected.
        }
      }
    }
  }

  async dryRun(rawPayloadOrArgs: unknown, request?: RequestContext | unknown): Promise<DryRunResult> {
    await this.ensureReady();
    // Same intake as handle(); per-request configureInvocation is deliberately skipped
    // (detection only — no invocation is being configured).
    const { envelope, req } = await this.intake(rawPayloadOrArgs, request);

    const invocationId = req.invocationId ? asInvocationId(req.invocationId) : newInvocationId();
    const correlationId = envelope.correlationId ?? newCorrelationId();
    const invocation: InvocationContext = {
      invocationId,
      correlationId,
      source: envelope.source,
      sourceType: this.pm.sourceType,
      envelope,
      request: req,
      startedAt: new Date(),
      signal: new AbortController().signal,
      log: createHandlerLogger({ invocationId, correlationId, scope: 'dry-run' }, entry => void this.pm.onLog(entry)),
      provided: {},
    };

    // Kit-level prepare runs in dryRun too, so detectors that read `ctx.provided` behave
    // identically. (Module `prepare` / jobs / resolve still do NOT run — detection only.)
    invocation.provided = await this.runKitPrepare(invocation);
    const detected = await this.detect(envelope, invocation);
    const jobNamesOf = (module: EventModule): string[] =>
      (module.jobs ?? []).map(entry => String((entry as { name?: unknown }).name ?? 'anonymous'));

    return {
      invocationId,
      correlationId,
      events: detected.map(d => {
        const ev: DryRunResult['events'][number] = {
          name: String(d.module.name),
          detected: d.event !== null,
          jobs: d.event !== null ? jobNamesOf(d.module) : [],
        };
        if (d.error !== undefined) ev.error = d.error.message;
        return ev;
      }),
    };
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
        provided: invocation.provided,
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

  /**
   * Run a module's response seam (`resolve` or `respond`) and map its outcome
   * (ADR-026): a returned value becomes the response output; a throw becomes the
   * wire error (`toResolvedError`), reported through `onError` at phase 'handle'.
   */
  private async runResponseSeam(
    seam: () => unknown,
    invocation: InvocationContext,
    eventName: EventName,
  ): Promise<{ resolved: ResolvedOutcome; error?: SerializedError }> {
    try {
      return { resolved: { hasResolved: true, output: await seam() } };
    } catch (err) {
      await this.pm.reportError(err, 'handle', {
        invocationId: invocation.invocationId,
        correlationId: invocation.correlationId,
        eventName,
      });
      return { resolved: { hasResolved: true, error: toResolvedError(err) }, error: serializeError(err) };
    }
  }

  /**
   * For each detected event: build its handler context, run `prepare` once (if any),
   * then hand the module's STATIC `jobs` array to the runtime executor (ADR-025 —
   * there is no handler body). `prepare`'s output is merged into every job's input.
   * A crash in `prepare` is reported and surfaced (detected:true, no jobs, `error`),
   * mirroring the legacy handler-crash semantics; `ok` stays job-status-only so a
   * prepare crash with no jobs does not flip it (no-retry contract).
   */
  private async dispatch(
    detected: Array<{ module: EventModule; event: DetectedEvent | null; error?: SerializedError }>,
    envelope: EventEnvelope,
    invocation: InvocationContext,
    runtime: InvocationRuntime,
  ): Promise<{ events: EventOutcome[]; resolved?: ResolvedOutcome }> {
    const events: EventOutcome[] = [];
    // The FIRST detected module with a `resolve` provides the invocation's response
    // (ADR-026). Captured here and surfaced on InvocationResult for the platform.
    let resolved: ResolvedOutcome | undefined;
    for (const entry of detected) {
      const { module, event } = entry;

      // Detector crash: report it (detected:false, no jobs); no jobs run.
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
        provided: invocation.provided,
      };
      const ctx = this.pm.buildHandlerContext(envelope, base);

      await this.pm.onEventHandlerStart(ctx);
      const handlerStart = Date.now();
      let jobs: JobExecution[] = [];
      let error: ReturnType<typeof serializeError> | undefined;
      let moduleResolved: ResolvedOutcome | undefined;
      try {
        // prepare() runs ONCE before the jobs + resolve; its result is shared into the
        // job input AND the resolve context (data only — never job selection).
        const prepared = module.prepare ? ((await module.prepare(ctx)) as Record<string, unknown>) : {};
        const jobInputCtx: JobInputContext = { ...(ctx as HandlerContext), prepared };
        // Kick off jobs (fire-and-forget, never reject) and resolve (the response)
        // CONCURRENTLY — they are sibling-ignorant (ADR-025/026); resolve never reads
        // job results. Await both so serverless doesn't freeze mid-side-effect.
        const jobsPromise = runJobs(runtime, event, module.jobs ?? [], module.run, jobInputCtx);
        if (module.resolve) {
          const r = await this.runResponseSeam(() => module.resolve!(jobInputCtx), invocation, event.name);
          moduleResolved = r.resolved;
          if (r.error !== undefined) error = r.error;
        }
        jobs = await jobsPromise;
        // ADR-026 amendment: `respond` is the RESULT-DRIVEN response — sequenced AFTER the
        // jobs settle, handed their executions + an `ok` flag (same predicate as
        // InvocationResult.ok), so the synchronous reply can reflect the outcome. Mutually
        // exclusive with `resolve` (enforced at register time). Jobs keep their own retry /
        // durability — `respond` only reads results; a throw maps to the wire error.
        if (module.respond) {
          const ok = jobs.every(j => j.status === 'completed' || j.status === 'skipped');
          const r = await this.runResponseSeam(() => module.respond!(jobInputCtx, { jobs, ok }), invocation, event.name);
          moduleResolved = r.resolved;
          if (r.error !== undefined) error = r.error;
        }
      } catch (err) {
        // A prepare() crash — neither jobs nor a response seam produced anything. For a
        // request/response module this becomes the error response.
        error = serializeError(err);
        if (module.resolve || module.respond) moduleResolved = { hasResolved: true, error: toResolvedError(err) };
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

      // detected stays true even on a prepare/resolve crash (the event WAS detected);
      // the error is surfaced separately. `ok` is computed from job status only — a
      // resolve crash maps to the wire error response, not to a job-failure retry.
      const outcome: EventOutcome = { name: event.name, detected: true, jobs };
      if (error !== undefined) outcome.error = error;
      events.push(outcome);

      if (moduleResolved && !resolved) resolved = moduleResolved; // first resolve wins
    }
    return resolved ? { events, resolved } : { events };
  }

  async shutdown(): Promise<void> {
    await this.pm.onFlush();
    await this.pm.onShutdown();
  }

  // Read-only registry walk (§14–§16). Resolves plugins (idempotent) so source /
  // platform / plugin names are populated, then reflects the declared structure —
  // it runs no detector, prepare, job, or lifecycle hook. Faithful precisely
  // because modules are declarative (ADR-025): the job set is a static array.
  describe(): KitDescription {
    this.pm.resolve();

    // The source and platform are singleton capability providers, not observer/
    // transform plugins — list only the latter under `plugins`.
    const plugins = this.pm.pluginsInOrder
      .filter(p => p !== this.pm.source && p !== this.pm.platform)
      .map(p => p.name);

    const events: KitEventDescription[] = this.modules.map(m => {
      const response: FlowResponseKind = m.respond ? 'respond' : m.resolve ? 'resolve' : 'none';
      const jobs: KitJobDescription[] = (m.jobs ?? []).map(entry => {
        // Jobs are normalized to JobDefinition at register time; stay defensive.
        const def = isJobDefinition(entry) ? (entry as JobDefinition) : undefined;
        const opts = def?.options ?? {};
        const j: KitJobDescription = {
          name: def ? String(def.name) : (entry as { name?: string }).name ?? 'anonymous',
        };
        if (opts.retries !== undefined) j.retries = opts.retries;
        if (opts.timeoutMs !== undefined) j.timeoutMs = opts.timeoutMs;
        // continueOnFailure is gone from JobOptions (ADR-031) and the register guard rejects
        // it, so this only ever populates for a legacy/untyped shape — read it defensively.
        const cof = (opts as { continueOnFailure?: boolean }).continueOnFailure;
        if (cof !== undefined) j.continueOnFailure = cof;
        if (opts.tags && opts.tags.length) j.tags = opts.tags;
        if (opts.metadata && Object.keys(opts.metadata).length) j.metadata = opts.metadata;
        return j;
      });

      const meta = m.metadata as EventModuleMetadata | undefined;
      const ev: KitEventDescription = { name: String(m.name), response, jobs };
      // run.mode is gone from RunOptions (ADR-031) and the register guard rejects a
      // non-parallel mode, so this reads defensively for a legacy/untyped shape.
      const runMode = (m.run as { mode?: 'parallel' | 'series' } | undefined)?.mode;
      if (runMode) ev.runMode = runMode;
      if (meta?.description) ev.description = meta.description;
      if (meta?.owner) ev.owner = meta.owner;
      if (meta?.tags && meta.tags.length) ev.tags = meta.tags;
      if (meta?.deprecated) ev.deprecated = true;
      if (meta?.flowHints) ev.flowHints = meta.flowHints;
      return ev;
    });

    const description: KitDescription = {
      source: { name: this.pm.source.name, type: this.pm.sourceType },
      plugins,
      events,
    };
    if (this.pm.platform) description.platform = this.pm.platform.name;
    return description;
  }
}

/**
 * Construct a kit once at module scope with its single required source (the first
 * positional arg — ADR-019). Everything else registers via `kit.use(plugin, config?)`.
 */
export function createEventKit(source: EventKitPlugin | PluginFactory, config?: unknown): EventKit {
  return new Kit(source, config);
}
