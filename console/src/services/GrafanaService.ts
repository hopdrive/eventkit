/**
 * Grafana Loki Service
 *
 * Provides integration with Grafana Loki for fetching logs from the
 * EventKit / event-handlers system.
 *
 * All requests go through the `/api/grafana/*` proxy (the Vite dev-server
 * proxy locally, the `grafana-proxy` Netlify function in production). The
 * proxy injects Grafana basic-auth credentials server-side from
 * GRAFANA_HOST/GRAFANA_ID/GRAFANA_SECRET — the client never sees them and
 * never sends an Authorization header itself (bug B1 / S3 fix: the legacy
 * console read VITE_GRAFANA_* client-side and shipped the secret in the
 * bundle in any deployed build).
 */

export interface LogEntry {
  timestamp: string; // ISO timestamp
  timestampNs: string; // Nanosecond precision timestamp
  level: string; // info, warn, error, debug
  message: string;
  labels: Record<string, string>;
  raw: any; // Raw JSON data from log
}

export interface LogQueryParams {
  query: string; // LogQL query
  start?: number; // Unix timestamp in nanoseconds
  end?: number; // Unix timestamp in nanoseconds
  limit?: number; // Max number of logs to return
  direction?: 'forward' | 'backward';
}

export interface LogQueryResult {
  logs: LogEntry[];
  stats?: {
    totalBytes: number;
    totalEntries: number;
  };
}

/**
 * Build a LogQL query for an invocation node
 */
export function buildInvocationQuery(invocationId: string): string {
  return `{app="event-handlers", invocationId="${invocationId}"}`;
}

/**
 * Build a LogQL query for an event node
 */
export function buildEventQuery(
  correlationId: string,
  eventExecutionId?: string
): string {
  if (eventExecutionId) {
    return `{app="event-handlers", correlationId="${correlationId}", eventExecutionId="${eventExecutionId}"}`;
  }
  return `{app="event-handlers", correlationId="${correlationId}"}`;
}

/**
 * Build a LogQL query for a job node
 */
export function buildJobQuery(
  scopeId: string,
  jobExecutionId?: string
): string {
  if (jobExecutionId) {
    return `{app="event-handlers", scopeId="${scopeId}", jobExecutionId="${jobExecutionId}"}`;
  }
  return `{app="event-handlers", scopeId="${scopeId}"}`;
}

/**
 * Parse Loki response and extract log entries
 */
function parseLokiResponse(data: any): LogEntry[] {
  const logs: LogEntry[] = [];

  if (!data?.data?.result) {
    return logs;
  }

  for (const stream of data.data.result) {
    const labels = stream.stream || {};

    for (const [timestampNs, logLine] of stream.values || []) {
      try {
        // Try to parse as JSON
        const parsed = JSON.parse(logLine);

        logs.push({
          timestamp: new Date(parseInt(timestampNs) / 1000000).toISOString(),
          timestampNs,
          level: parsed.level || labels.level || 'info',
          message: parsed.message || logLine,
          labels: { ...labels, ...parsed },
          raw: parsed,
        });
      } catch {
        // If not JSON, treat as plain text
        logs.push({
          timestamp: new Date(parseInt(timestampNs) / 1000000).toISOString(),
          timestampNs,
          level: labels.level || 'info',
          message: logLine,
          labels,
          raw: { message: logLine },
        });
      }
    }
  }

  // Sort by timestamp ascending (oldest first)
  logs.sort((a, b) => parseInt(a.timestampNs) - parseInt(b.timestampNs));

  return logs;
}

/**
 * GrafanaService class for querying Loki via the server-side proxy.
 * Holds no credentials — the proxy (dev-server or Netlify function) owns
 * auth entirely.
 */
export class GrafanaService {
  /**
   * Path prefix the client hits for the Loki proxy. Comes from the console
   * config (`grafanaProxyPath`, default `/api/grafana`); the host routes it
   * to a server-side proxy that injects basic-auth.
   */
  constructor(private readonly basePath: string = '/api/grafana') {}

  /**
   * Query Loki for logs
   */
  async queryLogs(params: LogQueryParams): Promise<LogQueryResult> {
    const {
      query,
      start,
      end,
      limit = 1000,
      direction = 'forward',
    } = params;

    // Build query parameters
    const queryParams = new URLSearchParams({
      query: query,
      limit: limit.toString(),
      direction,
    });

    if (start) {
      queryParams.append('start', start.toString());
    }

    if (end) {
      queryParams.append('end', end.toString());
    }

    // Always use the proxy endpoint — it forwards to Grafana and injects
    // basic-auth server-side (dev: vite.config.ts proxy; prod: the
    // grafana-proxy function via a host redirect). The prefix is config-driven.
    const url = `${this.basePath}/loki/api/v1/query_range?${queryParams.toString()}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Grafana API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      const logs = parseLokiResponse(data);

      return {
        logs,
        stats: data.data?.stats,
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to fetch logs from Grafana: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Query logs for a specific invocation
   */
  async queryInvocationLogs(
    invocationId: string,
    timeRangeMinutes: number = 30
  ): Promise<LogQueryResult> {
    const query = buildInvocationQuery(invocationId);
    const now = Date.now();
    const start = (now - timeRangeMinutes * 60 * 1000) * 1000000; // Convert to nanoseconds
    const end = (now + timeRangeMinutes * 60 * 1000) * 1000000;

    return this.queryLogs({
      query,
      start,
      end,
      limit: 1000,
      direction: 'forward',
    });
  }

  /**
   * Query logs for a specific event
   */
  async queryEventLogs(
    correlationId: string,
    eventExecutionId: string | undefined,
    timeRangeMinutes: number = 30
  ): Promise<LogQueryResult> {
    const query = buildEventQuery(correlationId, eventExecutionId);
    const now = Date.now();
    const start = (now - timeRangeMinutes * 60 * 1000) * 1000000;
    const end = (now + timeRangeMinutes * 60 * 1000) * 1000000;

    return this.queryLogs({
      query,
      start,
      end,
      limit: 1000,
      direction: 'forward',
    });
  }

  /**
   * Query logs for a specific job
   */
  async queryJobLogs(
    scopeId: string,
    jobExecutionId: string | undefined,
    timeRangeMinutes: number = 30
  ): Promise<LogQueryResult> {
    const query = buildJobQuery(scopeId, jobExecutionId);
    const now = Date.now();
    const start = (now - timeRangeMinutes * 60 * 1000) * 1000000;
    const end = (now + timeRangeMinutes * 60 * 1000) * 1000000;

    return this.queryLogs({
      query,
      start,
      end,
      limit: 1000,
      direction: 'forward',
    });
  }
}

/**
 * Create a GrafanaService instance.
 *
 * The service never needs client-side Grafana credentials (that would
 * ship them in the bundle — see the file header comment): it always talks
 * to the `/api/grafana/*` proxy, which is either configured (dev-server
 * proxy or the Netlify function has GRAFANA_* env vars) or returns an
 * error that the caller surfaces in the Logs tab. Kept as a factory
 * function (rather than a bare `new GrafanaService()`) so call sites don't
 * need to change and a future health-check could still gate this.
 */
export function createGrafanaService(basePath?: string): GrafanaService {
  return new GrafanaService(basePath ?? '/api/grafana');
}
