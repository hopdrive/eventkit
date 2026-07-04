// =============================================================================
// eventkit/plugins/observability/graphql-sink
// =============================================================================
// The built-in observability sink: bulk-upserts an ObservabilityBatch to the
// canonical Hasura observability tables (invocations / event_executions /
// job_executions). Endpoint + headers are injected config (never process.env);
// the table/mutation shapes are the fixed generic schema that ships with the
// package — textbook generic-by-config (ADR-024). Dependency-free: uses `fetch`,
// so `graphql-request` is not pulled in. On its own subpath so apps that wire a
// custom sink don't bundle it.
//
// Resilience (so telemetry survives real-world edge cases):
//  - Transport failures (network / 5xx) retry with backoff; GraphQL-level errors
//    (a malformed mutation, a constraint violation) are deterministic and are NOT
//    retried — they surface immediately.
//  - `source_job_id` is a FK to job_executions(id). If the prior job isn't recorded
//    (a non-eventkit writer, observability was down when it ran, …) the invocation
//    insert would FK-violate and drop the WHOLE record. We catch that specific
//    violation and retry the invocation WITHOUT `source_job_id` — keeping the
//    telemetry, dropping only the unverifiable link.
//  - eventkit emits a richer status vocabulary than the legacy schema's CHECK
//    constraints allow; `mapStatuses` (default on) maps to the allowed set so
//    writes stay valid. Set `mapStatuses: false` if you migrate the schema to
//    accept the full set, and/or override individual mappings via `statusMap`.
import type { ObservabilityBatch, InvocationRecord } from './index.js';

export interface StatusMap {
  invocations?: Record<string, string>;
  events?: Record<string, string>;
  jobs?: Record<string, string>;
}

export interface GraphqlSinkConfig {
  /** Hasura GraphQL endpoint. */
  endpoint: string;
  /** Request headers — `{ 'x-hasura-admin-secret': '…' }` or an auth bearer. Secrets live here. */
  headers?: Record<string, string>;
  /** Per-request timeout (ms). Default 30000. */
  timeoutMs?: number;
  /** Retry attempts on TRANSPORT failure (network/5xx). Default 3. GraphQL errors are not retried. */
  maxRetries?: number;
  /** Base backoff (ms), doubled per attempt. Default 500. */
  retryDelayMs?: number;
  /**
   * Map eventkit statuses to the legacy schema's CHECK-constraint set (default true).
   * Set false if your observability schema accepts eventkit's full status vocabulary.
   */
  mapStatuses?: boolean;
  /** Override/extend the default status mappings (merged over the defaults). */
  statusMap?: StatusMap;
  /** Override the transport (testing / custom client). Default posts via fetch. */
  request?: (body: { query: string; variables: Record<string, unknown> }, target: { endpoint: string; headers: Record<string, string> }) => Promise<unknown>;
}

// Default mappings from eventkit's status vocabulary to the legacy schema's CHECK sets:
//   invocations.status   ∈ {running, completed, failed}
//   event_executions     ∈ {detecting, not_detected, handling, completed, failed, detection_failed, handler_failed}
//   job_executions.status∈ {running, completed, failed}
const DEFAULT_STATUS_MAP: Required<StatusMap> = {
  invocations: { timeout: 'failed' },
  events: { pending: 'detecting', detected: 'handling' },
  jobs: { timed_out: 'failed', cancelled: 'failed', skipped: 'failed' },
};

/** A GraphQL-level error (deterministic — not retried). */
class GraphqlResponseError extends Error {
  override readonly name = 'GraphqlResponseError';
  constructor(public readonly errors: unknown[]) {
    super(`GraphQL errors: ${JSON.stringify(errors)}`);
  }
}

const INVOCATION_COLUMNS = [
  'correlation_id', 'source_function', 'source_table', 'source_operation', 'source_system',
  'source_type', 'source_event_id', 'source_event_payload', 'source_event_time', 'source_user_email',
  'source_user_role', 'source_job_id', 'context_data', 'total_duration_ms', 'events_detected_count',
  'total_jobs_run', 'total_jobs_succeeded', 'total_jobs_failed', 'status', 'error_message',
  'error_stack', 'updated_at',
];
const EVENT_COLUMNS = [
  'invocation_id', 'correlation_id', 'event_name', 'event_module_path', 'detected',
  'detection_duration_ms', 'detection_error', 'detection_error_stack', 'handler_duration_ms',
  'handler_error', 'handler_error_stack', 'jobs_count', 'jobs_succeeded', 'jobs_failed', 'status', 'updated_at',
];
const JOB_COLUMNS = [
  'invocation_id', 'event_execution_id', 'correlation_id', 'job_name', 'job_function_name',
  'job_options', 'duration_ms', 'status', 'result', 'error_message', 'error_stack', 'updated_at',
];

const upsert = (table: string, constraint: string, columns: string[]): string => `
  mutation Upsert_${table}($objects: [${table}_insert_input!]!) {
    insert_${table}(objects: $objects, on_conflict: { constraint: ${constraint}, update_columns: [${columns.join(', ')}] }) {
      affected_rows
    }
  }
`;

const MUT_INVOCATIONS = upsert('invocations', 'invocations_pkey', INVOCATION_COLUMNS);
const MUT_EVENTS = upsert('event_executions', 'event_executions_pkey', EVENT_COLUMNS);
const MUT_JOBS = upsert('job_executions', 'job_executions_pkey', JOB_COLUMNS);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Drop undefined keys so omitted columns are not sent (Hasura would otherwise null them on upsert).
const clean = <T extends object>(record: T): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) if (v !== undefined) out[k] = v;
  return out;
};

const isSourceJobIdFkError = (err: unknown): boolean =>
  err instanceof GraphqlResponseError && /source_job_id/i.test(JSON.stringify(err.errors));

export function graphqlSink(config: GraphqlSinkConfig): (batch: ObservabilityBatch) => Promise<void> {
  if (!config?.endpoint) throw new Error('graphqlSink() requires an `endpoint`.');
  const headers = { 'content-type': 'application/json', ...(config.headers ?? {}) };
  const timeoutMs = config.timeoutMs ?? 30000;
  const maxRetries = config.maxRetries ?? 3;
  const retryDelayMs = config.retryDelayMs ?? 500;
  const mapStatuses = config.mapStatuses !== false;
  const statusMap: Required<StatusMap> = {
    invocations: { ...DEFAULT_STATUS_MAP.invocations, ...(config.statusMap?.invocations ?? {}) },
    events: { ...DEFAULT_STATUS_MAP.events, ...(config.statusMap?.events ?? {}) },
    jobs: { ...DEFAULT_STATUS_MAP.jobs, ...(config.statusMap?.jobs ?? {}) },
  };

  // Clean a record (drop undefined keys) and map its status to the schema's allowed
  // set — operating on the COPY, never mutating the caller's batch (which the
  // observability buffer may re-send under periodic flush).
  const cleanAndMap = <T extends object>(record: T, table: keyof StatusMap): Record<string, unknown> => {
    const obj = clean(record);
    if (mapStatuses && typeof obj['status'] === 'string') {
      const mapped = statusMap[table][obj['status'] as string];
      if (mapped) obj['status'] = mapped;
    }
    return obj;
  };

  const defaultRequest = async (body: { query: string; variables: Record<string, unknown> }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(config.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Transport failure → retryable Error.
      if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  };
  const doRequest = config.request ?? defaultRequest;

  const send = async (query: string, objects: Record<string, unknown>[]): Promise<void> => {
    if (objects.length === 0) return;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await doRequest({ query, variables: { objects } }, { endpoint: config.endpoint, headers });
        // GraphQL-level failure → deterministic, NOT retried (applies to default + custom transports).
        const errors = (result as { errors?: unknown[] } | null | undefined)?.errors;
        if (errors && errors.length) throw new GraphqlResponseError(errors);
        return;
      } catch (err) {
        lastErr = err;
        if (err instanceof GraphqlResponseError) throw err;
        if (attempt < maxRetries) await sleep(retryDelayMs * 2 ** attempt);
      }
    }
    throw lastErr;
  };

  const sendInvocation = async (record: InvocationRecord): Promise<void> => {
    const obj = cleanAndMap(record, 'invocations');
    try {
      await send(MUT_INVOCATIONS, [obj]);
    } catch (err) {
      // Graceful degrade: a bad source_job_id link must not drop the whole record.
      if (isSourceJobIdFkError(err) && 'source_job_id' in obj) {
        const { source_job_id: _dropped, ...withoutLink } = obj;
        await send(MUT_INVOCATIONS, [withoutLink]);
        return;
      }
      throw err;
    }
  };

  return async (batch: ObservabilityBatch): Promise<void> => {
    // Order matters for FKs: invocation → events → jobs.
    await sendInvocation(batch.invocation);
    await send(MUT_EVENTS, batch.events.map(e => cleanAndMap(e, 'events')));
    await send(MUT_JOBS, batch.jobs.map(j => cleanAndMap(j, 'jobs')));
  };
}
