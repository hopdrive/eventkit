// =============================================================================
// @hopdrive/eventkit/plugins/observability/graphql-sink
// =============================================================================
// The built-in observability sink: bulk-upserts an ObservabilityBatch to the
// canonical Hasura observability tables (invocations / event_executions /
// job_executions). Endpoint + headers are injected config (never process.env);
// the table/mutation shapes are the fixed generic schema that ships with the
// package — textbook generic-by-config (ADR-024). Dependency-free: uses `fetch`,
// so `graphql-request` is not pulled in. On its own subpath so apps that wire a
// custom sink don't bundle it.
import type { ObservabilityBatch, InvocationRecord, EventRecord, JobRecord } from './index.js';

export interface GraphqlSinkConfig {
  /** Hasura GraphQL endpoint. */
  endpoint: string;
  /** Request headers — `{ 'x-hasura-admin-secret': '…' }` or an auth bearer. Secrets live here. */
  headers?: Record<string, string>;
  /** Per-request timeout (ms). Default 30000. */
  timeoutMs?: number;
  /** Retry attempts on transport failure. Default 3. */
  maxRetries?: number;
  /** Base backoff (ms), doubled per attempt. Default 500. */
  retryDelayMs?: number;
  /** Override the transport (testing / custom client). Default posts via fetch. */
  request?: (body: { query: string; variables: Record<string, unknown> }, target: { endpoint: string; headers: Record<string, string> }) => Promise<unknown>;
}

const INVOCATION_COLUMNS = [
  'correlation_id', 'source_function', 'source_table', 'source_operation', 'source_system',
  'source_event_id', 'source_event_payload', 'source_event_time', 'source_user_email',
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

export function graphqlSink(config: GraphqlSinkConfig): (batch: ObservabilityBatch) => Promise<void> {
  if (!config?.endpoint) throw new Error('graphqlSink() requires an `endpoint`.');
  const headers = { 'content-type': 'application/json', ...(config.headers ?? {}) };
  const timeoutMs = config.timeoutMs ?? 30000;
  const maxRetries = config.maxRetries ?? 3;
  const retryDelayMs = config.retryDelayMs ?? 500;

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
      if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
      const json = (await res.json()) as { errors?: unknown[] };
      if (json.errors && json.errors.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
      return json;
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
        await doRequest({ query, variables: { objects } }, { endpoint: config.endpoint, headers });
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries) await sleep(retryDelayMs * 2 ** attempt);
      }
    }
    throw lastErr;
  };

  return async (batch: ObservabilityBatch): Promise<void> => {
    // Order matters for FKs: invocation → events → jobs.
    await send(MUT_INVOCATIONS, [clean<InvocationRecord>(batch.invocation)]);
    await send(MUT_EVENTS, batch.events.map(e => clean<EventRecord>(e)));
    await send(MUT_JOBS, batch.jobs.map(j => clean<JobRecord>(j)));
  };
}
