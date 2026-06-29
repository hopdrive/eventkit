// =============================================================================
// @hopdrive/eventkit/plugins/transports/grafana
// =============================================================================
// A log BRIDGE (ADR-024). It forwards framework + job logs to a log sink; it does
// NOT own Grafana/Loki plumbing unless you ask it to. Two mutually-exclusive modes:
//
//   1. Injected logger (the HopDrive path) — pass `logger` (e.g. the result of
//      `getLogger()` from `@hopdrive/sdk-server-logger`). The plugin forwards
//      onLog/onJobLog/onError straight to it with structured metadata, exactly like
//      the legacy `grafanaLoggerPlugin`. The SDK owns the Loki endpoint, payload
//      shape, label trimming, auth, and queue flush — eventkit never touches them.
//      Flush is the consumer's job (e.g. `withLoggingInit`), so this mode does NOT
//      flush unless you inject a `flush` seam.
//
//   2. Direct Loki (the standalone path) — pass `grafana: { endpoint, auth, labels }`
//      and the plugin builds its own Loki-backed sink and flushes it at onFlush.
//      For non-HopDrive deployments with no server-logger SDK in play.
//
// The plugin NEVER reads process.env in either mode — config is always injected.
import type { EventKitPlugin, ErrorContext, JobContext, LogEntry, LogLevel } from '../../../core/index.js';

/**
 * Minimal logger contract the bridge forwards to. Deliberately matches
 * `@hopdrive/sdk-server-logger`'s `getLogger()` shape so injecting it is natural:
 * `error` takes `(message, error, metadata)`; the rest take `(message, metadata)`.
 */
export interface LoggerLike {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, error?: unknown, metadata?: Record<string, unknown>): void;
  /** Optional. Falls back to `info` when absent. */
  debug?(message: string, metadata?: Record<string, unknown>): void;
}

/** Direct-Loki transport config — used ONLY in mode 2 (`grafana: {...}`). */
export interface GrafanaTransportConfig {
  /** Loki push endpoint, e.g. `https://logs-prod.grafana.net/loki/api/v1/push`. */
  endpoint: string;
  /** Resolved to request headers. Secrets arrive here, never from the environment. */
  auth?: { bearer?: string; headers?: Record<string, string> };
  /** Static Loki stream labels merged into every line. */
  labels?: Record<string, string>;
  /** Delivery seam. Default posts the Loki payload via fetch. Inject for tests/custom clients. */
  send?: (payload: LokiPayload, target: { endpoint: string; headers: Record<string, string> }) => void | Promise<void>;
}

export interface GrafanaLoggerConfig {
  /** Mode 1: forward to this logger (e.g. `getLogger()` from sdk-server-logger). */
  logger?: LoggerLike;
  /** Mode 2: build a Loki transport from this config when no `logger` is given. */
  grafana?: GrafanaTransportConfig;
  /** `source` field stamped on every line's metadata. Default `'eventkit'`. */
  source?: string;
  /** Minimum level to forward. Default `'debug'` (everything). */
  minLevel?: LogLevel;
  /**
   * Optional flush seam for mode 1. Most consumers let `withLoggingInit` flush the
   * server-logger queue; inject this only if you want the plugin to flush at the end
   * of every invocation (e.g. `flush: () => flushLogs()`). Ignored in mode 2 (the
   * Loki sink always flushes itself).
   */
  flush?: () => void | Promise<void>;
}

export interface LokiPayload {
  streams: Array<{ stream: Record<string, string>; values: Array<[string, string]> }>;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const defaultSend = async (payload: LokiPayload, target: { endpoint: string; headers: Record<string, string> }) => {
  await fetch(target.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...target.headers },
    body: JSON.stringify(payload),
  });
};

/** What every forwarding path consumes — level + message + structured metadata + optional error + timestamp. */
type Emit = (level: LogLevel, message: string, metadata: Record<string, unknown>, error: unknown, at: Date) => void;

/** Build a Loki-backed emit/flush pair (mode 2). Correlation/identity fields live in the
 *  log LINE (structured), never as Loki stream labels — high-cardinality values
 *  (correlationId, jobExecutionId) as labels would explode Loki's index. */
function createLokiSink(cfg: GrafanaTransportConfig, source: string): { emit: Emit; flush: () => Promise<void> } {
  if (!cfg.endpoint) throw new Error('grafanaLogger({ grafana }) requires an `endpoint`.');
  const labels = cfg.labels ?? {};
  const send = cfg.send ?? defaultSend;
  const headers: Record<string, string> = { ...(cfg.auth?.headers ?? {}) };
  if (cfg.auth?.bearer) headers['authorization'] = `Bearer ${cfg.auth.bearer}`;

  const lines: Array<[string, string]> = [];

  const emit: Emit = (level, message, metadata, error, at) => {
    const ts = `${at.getTime()}000000`; // Loki wants nanosecond timestamps
    const line = JSON.stringify({
      level,
      message,
      ...metadata,
      ...(error ? { error } : {}),
    });
    lines.push([ts, line]);
  };

  const flush = async (): Promise<void> => {
    if (lines.length === 0) return;
    const values = lines.splice(0, lines.length);
    try {
      await send({ streams: [{ stream: { source, ...labels }, values }] }, { endpoint: cfg.endpoint, headers });
    } catch {
      // best-effort: a log-transport failure must not fail business execution
    }
  };

  return { emit, flush };
}

export function grafanaLogger(config: GrafanaLoggerConfig): EventKitPlugin {
  const source = config.source ?? 'eventkit';
  const minLevel = LEVEL_ORDER[config.minLevel ?? 'debug'];

  let emit: Emit;
  let flush: (() => void | Promise<void>) | undefined;

  if (config.logger) {
    // Mode 1 — bridge to the injected logger. The SDK stamps its own timestamps, so
    // `at` is unused here. Flush is the consumer's job unless a `flush` seam is given.
    const lg = config.logger;
    emit = (level, message, metadata, error) => {
      if (level === 'error') lg.error(message, error ?? null, metadata);
      else if (level === 'warn') lg.warn(message, metadata);
      else if (level === 'debug') (lg.debug ?? lg.info).call(lg, message, metadata);
      else lg.info(message, metadata);
    };
    flush = config.flush;
  } else if (config.grafana) {
    // Mode 2 — build and own a Loki transport.
    const loki = createLokiSink(config.grafana, source);
    emit = loki.emit;
    flush = loki.flush;
  } else {
    throw new Error(
      'grafanaLogger() requires either `logger` (e.g. getLogger() from @hopdrive/sdk-server-logger) or `grafana` (direct Loki config).',
    );
  }

  const metadataFor = (entry: LogEntry, extra?: { jobExecutionId?: string; trackingToken?: string }): Record<string, unknown> => ({
    source,
    ...(entry.scope ? { scope: entry.scope } : {}),
    ...(entry.invocationId ? { invocationId: entry.invocationId } : {}),
    ...(entry.correlationId ? { correlationId: entry.correlationId } : {}),
    ...(entry.eventName ? { eventName: entry.eventName } : {}),
    ...(entry.jobName ? { jobName: entry.jobName } : {}),
    ...(extra?.jobExecutionId ? { jobExecutionId: extra.jobExecutionId } : {}),
    ...(extra?.trackingToken ? { trackingToken: extra.trackingToken } : {}),
    ...(entry.data ? { data: entry.data } : {}),
  });

  const forward = (entry: LogEntry, extra?: { jobExecutionId?: string; trackingToken?: string }): void => {
    if (LEVEL_ORDER[entry.level] < minLevel) return;
    emit(entry.level, entry.message, metadataFor(entry, extra), entry.error, entry.at);
  };

  return {
    name: 'grafana-logger',
    onLog: (entry: LogEntry) => forward(entry),
    // Per-job-execution queryability: stamp ctx.job.id (the job_executions row id, also
    // the tracking token's 3rd segment) so dashboards can filter by it.
    onJobLog: (ctx: JobContext, entry: LogEntry) =>
      forward(entry, { jobExecutionId: ctx.job.id, ...(ctx.trackingToken ? { trackingToken: ctx.trackingToken } : {}) }),
    onError: (ctx: ErrorContext) =>
      emit(
        'error',
        `[${ctx.phase}] ${ctx.error.name}: ${ctx.error.message}`,
        {
          source,
          scope: ctx.phase,
          ...(ctx.invocationId ? { invocationId: ctx.invocationId } : {}),
          ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
          ...(ctx.eventName ? { eventName: ctx.eventName } : {}),
          ...(ctx.jobName ? { jobName: ctx.jobName } : {}),
        },
        ctx.error,
        new Date(),
      ),
    ...(flush ? { onFlush: () => flush!() } : {}),
  };
}
