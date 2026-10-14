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
// One round trip (ADR-045): by default the three upserts travel as ONE GraphQL document.
// Hasura runs every root mutation in a request sequentially inside a single transaction,
// so it is all-or-nothing and FK order (invocation → events → jobs) is kept. If that
// request is rejected at the GraphQL level, the sink falls back to the three separate
// upserts below, which carry the per-table graceful-degrade paths — and remembers that
// the invocation needed them, so its later writes go straight there.
//
// Resilience (so telemetry survives real-world edge cases):
//  - Transport failures (network / 5xx) retry with backoff; GraphQL-level errors
//    (a malformed mutation, a constraint violation) are deterministic and are NOT
//    retried — they surface immediately.
//  - `source_job_id` is a FK to job_executions(id). If the prior job isn't recorded
//    (a non-eventkit writer, observability was down when it ran, …) the invocation
//    insert would FK-violate and drop the WHOLE record. We catch that specific
//    violation and retry the invocation WITHOUT `source_job_id` — keeping the
//    telemetry, dropping only the unverifiable link. When the write is off the response
//    path (`info.deferred`), the sink first retries WITH the link on a short backoff
//    (`sourceJobLinkRetryMs`): the parent job's row is usually just a moment from landing
//    (its job-start write may run in the background). A link it gave up on is remembered,
//    so the invocation's later writes drop it at once.
//  - eventkit emits a richer status vocabulary than the legacy schema's CHECK
//    constraints allow; `mapStatuses` (default on) maps to the allowed set so
//    writes stay valid. Set `mapStatuses: false` if you migrate the schema to
//    accept the full set, and/or override individual mappings via `statusMap`.
import type { ObservabilityBatch, InvocationRecord, SinkWriteInfo } from './index.js';

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
  /**
   * Send the invocation, event and job upserts as ONE GraphQL request (default true).
   * Hasura executes them in one transaction. Set false to always send three requests.
   */
  singleRequest?: boolean;
  /**
   * Delays (ms) between retries of an invocation whose `source_job_id` names a job row that
   * isn't there yet, before the link is dropped. Only for writes off the response path
   * (`info.deferred`); a write the response waits on drops the link at once, as before
   * 0.8.0. Default `[250, 1000]`; `[]` never retries.
   */
  sourceJobLinkRetryMs?: number[];
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

// One upsert field — shared by the per-table mutations and the one-request batch, so the
// two can't drift.
const upsertField = (table: string, variable: string, constraint: string, columns: string[]): string =>
  `insert_${table}(objects: $${variable}, on_conflict: { constraint: ${constraint}, update_columns: [${columns.join(', ')}] }) { affected_rows }`;

const upsert = (table: string, constraint: string, columns: string[]): string => `
  mutation Upsert_${table}($objects: [${table}_insert_input!]!) {
    ${upsertField(table, 'objects', constraint, columns)}
  }
`;

const MUT_INVOCATIONS = upsert('invocations', 'invocations_pkey', INVOCATION_COLUMNS);
const MUT_EVENTS = upsert('event_executions', 'event_executions_pkey', EVENT_COLUMNS);
const MUT_JOBS = upsert('job_executions', 'job_executions_pkey', JOB_COLUMNS);

// All three upserts in one document — one round trip, one transaction (field order = FK order).
const MUT_BATCH = `
  mutation Upsert_observability_batch(
    $invocations: [invocations_insert_input!]!
    $events: [event_executions_insert_input!]!
    $jobs: [job_executions_insert_input!]!
  ) {
    ${upsertField('invocations', 'invocations', 'invocations_pkey', INVOCATION_COLUMNS)}
    ${upsertField('event_executions', 'events', 'event_executions_pkey', EVENT_COLUMNS)}
    ${upsertField('job_executions', 'jobs', 'job_executions_pkey', JOB_COLUMNS)}
  }
`;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A Set that forgets its oldest entries past `max`, so a warm instance's memory stays bounded. */
const boundedSet = (max: number) => {
  const items = new Set<string>();
  return {
    has: (k: string) => items.has(k),
    add: (k: string) => {
      items.add(k);
      if (items.size > max) items.delete(items.values().next().value as string);
    },
  };
};

// Drop undefined keys so omitted columns are not sent (Hasura would otherwise null them on upsert).
const clean = <T extends object>(record: T): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) if (v !== undefined) out[k] = v;
  return out;
};

const isSourceJobIdFkError = (err: unknown): boolean =>
  err instanceof GraphqlResponseError && /source_job_id/i.test(JSON.stringify(err.errors));

// Free-form JSON/text columns that carry the invocation's captured payloads. A GraphQL-level
// rejection on the events/jobs mutation (a serialization edge in `result`, a value the schema
// rejects) would otherwise lose the WHOLE row — and for a job that means its terminal `status`
// never lands, leaving it stuck `running`. These are the droppable ones: shed them and re-send
// so the row lands lossy-but-terminal. Mirrors the source_job_id degrade for invocations.
const DEGRADABLE_COLUMNS: Record<string, string[]> = {
  event_executions: ['detection_error_stack', 'handler_error_stack'],
  job_executions: ['result', 'job_options', 'error_stack'],
};

export function graphqlSink(config: GraphqlSinkConfig): (batch: ObservabilityBatch, info?: SinkWriteInfo) => Promise<void> {
  if (!config?.endpoint) throw new Error('graphqlSink() requires an `endpoint`.');
  const headers = { 'content-type': 'application/json', ...(config.headers ?? {}) };
  const timeoutMs = config.timeoutMs ?? 30000;
  const maxRetries = config.maxRetries ?? 3;
  const retryDelayMs = config.retryDelayMs ?? 500;
  const mapStatuses = config.mapStatuses !== false;
  const singleRequest = config.singleRequest !== false;
  const linkRetryMs = config.sourceJobLinkRetryMs ?? [250, 1000];
  // Links already given up on (`invocation|source_job_id`), and invocations whose one-request
  // write was rejected: their later writes skip straight to the outcome they'll get anyway.
  const deadLinks = boundedSet(1000);
  const needsSeparate = boundedSet(1000);
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
    await sendVariables(query, { objects });
  };

  const sendVariables = async (query: string, variables: Record<string, unknown>): Promise<void> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await doRequest({ query, variables }, { endpoint: config.endpoint, headers });
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

  const sendInvocation = async (record: InvocationRecord, deferred: boolean): Promise<void> => {
    const obj = cleanAndMap(record, 'invocations');
    const linkKey = `${record.id}|${String(obj['source_job_id'])}`;
    if ('source_job_id' in obj && deadLinks.has(linkKey)) delete obj['source_job_id'];
    const retries = deferred ? linkRetryMs : [];
    for (let attempt = 0; attempt <= retries.length; attempt++) {
      try {
        await send(MUT_INVOCATIONS, [obj]);
        return;
      } catch (err) {
        if (!(isSourceJobIdFkError(err) && 'source_job_id' in obj)) throw err;
        // The parent job's row may be a moment from landing — wait and try the link again.
        if (attempt < retries.length) await sleep(retries[attempt]!);
      }
    }
    // Graceful degrade: a link that never resolved must not drop the whole record.
    deadLinks.add(linkKey);
    const { source_job_id: _dropped, ...withoutLink } = obj;
    await send(MUT_INVOCATIONS, [withoutLink]);
  };

  // Send a bulk mutation; on a deterministic GraphQL-level rejection, retry ONCE with the
  // droppable payload columns stripped so the rows still land with their terminal status
  // (lossy but not lost). A bulk upsert fails atomically, so we can't know which object
  // offended — strip across the batch, which is the right trade to save every terminal row.
  const sendDegradable = async (query: string, table: string, objects: Record<string, unknown>[]): Promise<void> => {
    if (objects.length === 0) return;
    try {
      await send(query, objects);
    } catch (err) {
      const droppable = DEGRADABLE_COLUMNS[table];
      if (err instanceof GraphqlResponseError && droppable && objects.some(o => droppable.some(k => k in o))) {
        const stripped = objects.map(o => {
          const copy = { ...o };
          for (const k of droppable) delete copy[k];
          return copy;
        });
        await send(query, stripped);
        return;
      }
      throw err;
    }
  };

  // Order matters for FKs: invocation → events → jobs.
  const sendSeparately = async (batch: ObservabilityBatch, deferred: boolean): Promise<void> => {
    await sendInvocation(batch.invocation, deferred);
    await sendDegradable(MUT_EVENTS, 'event_executions', batch.events.map(e => cleanAndMap(e, 'events')));
    await sendDegradable(MUT_JOBS, 'job_executions', batch.jobs.map(j => cleanAndMap(j, 'jobs')));
  };

  return async (batch: ObservabilityBatch, info?: SinkWriteInfo): Promise<void> => {
    const deferred = info?.deferred === true;
    if (!singleRequest || needsSeparate.has(batch.invocation.id)) return sendSeparately(batch, deferred);
    const invocation = cleanAndMap(batch.invocation, 'invocations');
    // A link already given up on would only get the one request rejected again.
    if ('source_job_id' in invocation && deadLinks.has(`${batch.invocation.id}|${String(invocation['source_job_id'])}`)) {
      delete invocation['source_job_id'];
    }
    try {
      await sendVariables(MUT_BATCH, {
        invocations: [invocation],
        events: batch.events.map(e => cleanAndMap(e, 'events')),
        jobs: batch.jobs.map(j => cleanAndMap(j, 'jobs')),
      });
    } catch (err) {
      // A GraphQL-level rejection (an FK miss on source_job_id, a value a column rejects)
      // rolled the whole transaction back. Re-send per table, where each rejection has its
      // own graceful-degrade path. A transport failure was already retried — surface it.
      if (!(err instanceof GraphqlResponseError)) throw err;
      needsSeparate.add(batch.invocation.id);
      await sendSeparately(batch, deferred);
    }
  };
}
