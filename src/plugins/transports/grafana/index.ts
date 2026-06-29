// =============================================================================
// @hopdrive/eventkit/plugins/transports/grafana
// =============================================================================
// Generic log transport (ADR-024). Buffers framework + job logs and flushes them
// to a Grafana Loki push endpoint at onFlush (per invocation). Endpoint/auth/labels
// arrive via injected config — the plugin NEVER reads process.env. `send` is the
// delivery seam (default: fetch); inject it to test or to use a custom client.
import type { EventKitPlugin, ErrorContext, JobContext, LogEntry } from '../../../core/index.js';

export interface GrafanaTransportConfig {
  /** Loki push endpoint, e.g. `https://logs-prod.grafana.net/loki/api/v1/push`. */
  endpoint: string;
  /** Resolved to request headers. Secrets arrive here, never from the environment. */
  auth?: { bearer?: string; headers?: Record<string, string> };
  /** Static Loki stream labels merged into every line. */
  labels?: Record<string, string>;
  /** Minimum level to forward. Default `'debug'` (everything). */
  minLevel?: LogEntry['level'];
  /** Delivery seam. Default posts the Loki payload via fetch. Inject for tests/custom clients. */
  send?: (payload: LokiPayload, target: { endpoint: string; headers: Record<string, string> }) => void | Promise<void>;
}

export interface LokiPayload {
  streams: Array<{ stream: Record<string, string>; values: Array<[string, string]> }>;
}

const LEVEL_ORDER: Record<LogEntry['level'], number> = { debug: 10, info: 20, warn: 30, error: 40 };

const defaultSend = async (payload: LokiPayload, target: { endpoint: string; headers: Record<string, string> }) => {
  await fetch(target.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...target.headers },
    body: JSON.stringify(payload),
  });
};

export function grafanaTransport(config: GrafanaTransportConfig): EventKitPlugin {
  if (!config?.endpoint) throw new Error('grafanaTransport() requires an `endpoint`.');
  const labels = config.labels ?? {};
  const minLevel = LEVEL_ORDER[config.minLevel ?? 'debug'];
  const send = config.send ?? defaultSend;
  const headers: Record<string, string> = { ...(config.auth?.headers ?? {}) };
  if (config.auth?.bearer) headers['authorization'] = `Bearer ${config.auth.bearer}`;

  const lines: Array<[string, string]> = [];

  // Correlation/identity fields go in the log LINE (structured data), never as Loki
  // stream labels — high-cardinality values (correlationId, jobExecutionId) as labels
  // would explode Loki's index. This matches the legacy scoped-job, which put
  // jobExecutionId in structured metadata, not a stream label.
  const buffer = (entry: LogEntry, extra?: { jobExecutionId?: string; trackingToken?: string }): void => {
    if (LEVEL_ORDER[entry.level] < minLevel) return;
    const ts = `${entry.at.getTime()}000000`; // Loki wants nanosecond timestamps
    const line = JSON.stringify({
      source: 'eventkit',
      level: entry.level,
      message: entry.message,
      ...(entry.scope ? { scope: entry.scope } : {}),
      ...(entry.invocationId ? { invocationId: entry.invocationId } : {}),
      ...(entry.correlationId ? { correlationId: entry.correlationId } : {}),
      ...(entry.eventName ? { eventName: entry.eventName } : {}),
      ...(entry.jobName ? { jobName: entry.jobName } : {}),
      ...(extra?.jobExecutionId ? { jobExecutionId: extra.jobExecutionId } : {}),
      ...(extra?.trackingToken ? { trackingToken: extra.trackingToken } : {}),
      ...(entry.data ? { data: entry.data } : {}),
    });
    lines.push([ts, line]);
  };

  const flush = async (): Promise<void> => {
    if (lines.length === 0) return;
    const values = lines.splice(0, lines.length);
    try {
      await send({ streams: [{ stream: { source: 'eventkit', ...labels }, values }], }, { endpoint: config.endpoint, headers });
    } catch {
      // best-effort: a log-transport failure must not fail business execution
    }
  };

  return {
    name: 'grafana-transport',
    onLog: (entry: LogEntry) => buffer(entry),
    // Per-job-execution queryability: stamp ctx.job.id (the job_executions row id,
    // also the tracking token's 3rd segment) so dashboards can filter by it.
    onJobLog: (ctx: JobContext, entry: LogEntry) =>
      buffer(entry, { jobExecutionId: ctx.job.id, ...(ctx.trackingToken ? { trackingToken: ctx.trackingToken } : {}) }),
    onError: (ctx: ErrorContext) =>
      buffer({
        level: 'error',
        message: `[${ctx.phase}] ${ctx.error.name}: ${ctx.error.message}`,
        at: new Date(),
        scope: ctx.phase,
        ...(ctx.invocationId ? { invocationId: ctx.invocationId } : {}),
        ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
        ...(ctx.eventName ? { eventName: ctx.eventName } : {}),
        ...(ctx.jobName ? { jobName: ctx.jobName } : {}),
      }),
    onFlush: () => flush(),
  };
}
