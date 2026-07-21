// =============================================================================
// eventkit/plugins/batch — batch job definitions (authoring + insert side)
// =============================================================================
// A BATCH JOB DEFINITION pairs the three things that must never drift apart:
// the `trigger_type` string, the input codec, and the detection/insert plumbing
// derived from them. Authors keep the STANDARD event-module format — `batchJob()`
// only fills the two slots that are always the same for a batch job:
//
//   export const arBatch = batchJob({ triggerType: 'ar', input: ArInput });
//
//   export const batchCreatedAr = defineEvent({
//     name: 'batch.created.ar',
//     detector: arBatch.detector,                    // standard detector slot
//     jobs: [job(runAr, { input: arBatch.input })],  // standard input-mapper slot
//   });
//
// The SAME definition is the only sanctioned write path:
//
//   await createBatchJob(executor, arBatch, { moveId: 770603 }, { delayMs: 20_000 });
//
// so the trigger_type string exists in exactly one place per service, inserts are
// validated by the same codec that types the job's `ctx.input`, and "you can only
// create what you handle" is literal (you import the definition to do either).
//
// GRAPHQL COUPLING: `createBatchJob` and the executor-backed store speak the
// canonical HopDrive `batch_jobs` schema over a `mutate(document, variables)`
// executor (structurally `@hopdrive/sdk-core`'s GqlExecutor). Documents are
// shipped pre-printed via the `__text` convention, so no graphql dependency is
// added here and no runtime parse/print happens.

import type { DetectorFunction } from '../../core/index.js';
import type { HasuraDetectorContext } from '../hasura-shared/types.js';
import { getNewRow } from '../hasura-shared/payload.js';
import type { BatchJobStore, BatchJobUpdate, DelayedBatchJobSpec } from './index.js';

// -----------------------------------------------------------------------------
// Definition
// -----------------------------------------------------------------------------

/** Structural input validator — `zod` schemas satisfy this without a dependency. */
export interface BatchJobInputCodec<T> {
  parse(value: unknown): T;
}

export interface BatchJobConfig<T> {
  /** Free-form `batch_jobs.trigger_type` value. Uniqueness is enforced by tooling, not format. */
  triggerType: string;
  /**
   * Optional codec for the row's `input` jsonb. Validates at BOTH seams: on
   * `createBatchJob` (bad input never reaches the table) and in the job input
   * mapper (the job's `ctx.input` is the parsed, typed value). Omit → `unknown`.
   */
  input?: BatchJobInputCodec<T>;
}

/** The shape of the `batch_jobs` row the detector inspects. */
interface BatchJobsRow {
  id?: string | number;
  trigger_type?: string;
  status?: string;
  input?: unknown;
  [key: string]: unknown;
}

export interface BatchJobDefinition<T = unknown> {
  readonly triggerType: string;
  readonly codec?: BatchJobInputCodec<T>;
  /**
   * Drop-in for the standard event-module `detector` slot. Fires on INSERT of a
   * `batch_jobs` row with this `trigger_type`, and on the UPDATE→`pending` replay
   * path (an operator flipping a row back to `pending` re-runs it — the existing
   * retry convention the safety net documents).
   */
  readonly detector: DetectorFunction;
  /**
   * Drop-in for the standard `job(fn, { input })` mapper slot. Extracts the
   * triggering row's `input` and, when a codec was given, parses it — the job's
   * `ctx.input` is the validated `T`.
   */
  readonly input: (ctx: { envelope: { payload: unknown } }) => T;
}

/**
 * Define a batch job once: the trigger_type, its input codec, and the derived
 * standard-slot helpers. Pure data + pure functions; nothing registers anything.
 */
export function batchJob<T = unknown>(config: BatchJobConfig<T>): BatchJobDefinition<T> {
  const { triggerType, input: codec } = config;
  if (!triggerType || typeof triggerType !== 'string') {
    throw new Error('batchJob() requires a non-empty `triggerType` string.');
  }

  const detector = ((ctx: HasuraDetectorContext<BatchJobsRow>): boolean => {
    if (ctx.table !== 'batch_jobs') return false;
    const row = ctx.newRow;
    if (!row || row.trigger_type !== triggerType) return false;
    if (ctx.operation === 'INSERT') return true;
    // Replay path: an UPDATE that flips status back to 'pending' re-fires the job.
    return ctx.operation === 'UPDATE' && ctx.columnChanged('status') && row.status === 'pending';
  }) as unknown as DetectorFunction;

  const input = (ctx: { envelope: { payload: unknown } }): T => {
    const row = getNewRow(ctx.envelope.payload as never) as BatchJobsRow | null;
    const raw = row?.input;
    return codec ? codec.parse(raw) : (raw as T);
  };

  const def: BatchJobDefinition<T> = codec
    ? { triggerType, codec, detector, input }
    : { triggerType, detector, input };
  return def;
}

// -----------------------------------------------------------------------------
// Insert side
// -----------------------------------------------------------------------------

/**
 * Structural mutate-capable executor (`@hopdrive/sdk-core`'s GqlExecutor matches).
 * Documents are passed pre-printed via `__text`; the executor must honor that
 * convention (all sdk-core executors do).
 */
export interface BatchJobGqlExecutor {
  mutate<TData = unknown>(document: unknown, variables?: Record<string, unknown>): Promise<TData>;
}

/** Minimal pre-printed document honoring sdk-core's `__text` fast path. */
const gqlDoc = (text: string): { kind: string; definitions: { kind: string }[]; __text: string } => ({
  kind: 'Document',
  definitions: [{ kind: 'OperationDefinition' }],
  __text: text,
});

const INSERT_BATCH_JOB = gqlDoc(`
  mutation EventkitCreateBatchJob($object: batch_jobs_insert_input!) {
    insert_batch_jobs_one(object: $object) { id }
  }
`);

/** Dedup variant: a live `delay_key` collision inserts nothing and returns null. */
const INSERT_BATCH_JOB_DEDUP = gqlDoc(`
  mutation EventkitCreateBatchJobDeduped($object: batch_jobs_insert_input!) {
    insert_batch_jobs_one(
      object: $object
      on_conflict: { constraint: batch_jobs_delay_key_key, update_columns: [] }
    ) { id }
  }
`);

const UPDATE_BATCH_JOB = gqlDoc(`
  mutation EventkitUpdateBatchJob($id: bigint!, $fields: batch_jobs_set_input!) {
    update_batch_jobs_by_pk(pk_columns: { id: $id }, _set: $fields) { id }
  }
`);

const MARK_STRANDED = gqlDoc(`
  mutation EventkitMarkBatchJobStranded($id: bigint!, $output: jsonb!, $updatedat: timestamptz!) {
    update_batch_jobs(
      where: { id: { _eq: $id }, status: { _in: ["pending", "ready", "delaying"] } }
      _set: { status: "error", output: $output, updatedat: $updatedat }
    ) { affected_rows }
  }
`);

export interface CreateBatchJobOptions {
  /** Delay before the row becomes runnable (`delay_ms`). */
  delayMs?: number;
  /**
   * Dedup key: forms `delay_key = ${triggerType}-${uniqueKey}` (unique while a row
   * with it is pending/delaying). A live collision inserts nothing — the returned
   * `id` is null and `deduped` is true.
   */
  uniqueKey?: string;
  sequence?: number;
  batchId?: string;
  /** `createdby` stamp (e.g. 'system'). */
  user?: string;
  scheduledFor?: Date;
}

export interface CreateBatchJobResult {
  id: string | number | null;
  /** True when a `uniqueKey` collision meant an equivalent row is already live. */
  deduped: boolean;
}

interface InsertOneData {
  insert_batch_jobs_one: { id: string | number } | null;
}

/**
 * The one sanctioned way to write a `batch_jobs` row. Validates `input` through the
 * definition's codec (throws before any write on a mismatch), stamps the
 * definition's `trigger_type`, and inserts `status: 'pending'` so the Hasura
 * trigger fires the owning service's endpoint.
 */
export async function createBatchJob<T>(
  executor: BatchJobGqlExecutor,
  def: BatchJobDefinition<T>,
  input: T,
  options: CreateBatchJobOptions = {},
): Promise<CreateBatchJobResult> {
  const parsed = def.codec ? def.codec.parse(input) : input;
  const object: Record<string, unknown> = {
    trigger_type: def.triggerType,
    status: 'pending',
    input: parsed ?? {},
  };
  if (options.delayMs !== undefined) object['delay_ms'] = options.delayMs;
  if (options.uniqueKey !== undefined) object['delay_key'] = `${def.triggerType}-${options.uniqueKey}`;
  if (options.sequence !== undefined) object['sequence'] = options.sequence;
  if (options.batchId !== undefined) object['batch_id'] = options.batchId;
  if (options.user !== undefined) object['createdby'] = options.user;
  if (options.scheduledFor !== undefined) object['scheduled_for'] = options.scheduledFor.toISOString();

  const doc = options.uniqueKey !== undefined ? INSERT_BATCH_JOB_DEDUP : INSERT_BATCH_JOB;
  const data = await executor.mutate<InsertOneData>(doc, { object });
  const row = data?.insert_batch_jobs_one ?? null;
  return { id: row?.id ?? null, deduped: row === null };
}

// -----------------------------------------------------------------------------
// Canonical executor-backed store (used by `batch({ executor })`)
// -----------------------------------------------------------------------------

/**
 * The canonical GraphQL-backed `BatchJobStore` over the HopDrive `batch_jobs`
 * schema. Services pass their executor to `batch({ executor })` and never write
 * store plumbing; a hand-rolled `store` remains supported for tests/portability.
 */
export function executorBatchJobStore(
  executor: BatchJobGqlExecutor,
): Required<BatchJobStore> & { markStranded(id: string | number, output: unknown): Promise<boolean> } {
  // `markStranded` anticipates the stuck-row safety net (PR #37); harmless extra
  // capability until the plugin grows the `safetyNet` option.
  return {
    async update(id: string | number, fields: BatchJobUpdate): Promise<void> {
      await executor.mutate(UPDATE_BATCH_JOB, {
        id,
        fields: { ...fields, updatedat: new Date().toISOString() },
      });
    },

    async enqueueDelayed(spec: DelayedBatchJobSpec): Promise<void> {
      const object: Record<string, unknown> = {
        trigger_type: spec.triggerType,
        status: 'pending',
        delay_ms: spec.delayMs,
        delay_key: `${spec.triggerType}-${spec.uniqueKey}`,
        input: spec.input ?? {},
      };
      if (spec.sequence !== undefined) object['sequence'] = spec.sequence;
      if (spec.user !== undefined) object['createdby'] = spec.user;
      // Dedup is SUCCESS here: a live delay_key collision means an equivalent
      // retry row already exists, which is exactly the durable-retry guarantee.
      await executor.mutate(INSERT_BATCH_JOB_DEDUP, { object });
    },

    async markStranded(id: string | number, output: unknown): Promise<boolean> {
      const data = await executor.mutate<{ update_batch_jobs: { affected_rows: number } }>(MARK_STRANDED, {
        id,
        output,
        updatedat: new Date().toISOString(),
      });
      return (data?.update_batch_jobs?.affected_rows ?? 0) > 0;
    },
  };
}

// -----------------------------------------------------------------------------
// Hasura action handler (GraphQL-facing create endpoint)
// -----------------------------------------------------------------------------

export interface BatchJobsActionConfig {
  executor: BatchJobGqlExecutor;
  /** The definitions this service owns. Creation is refused for anything else. */
  batchjobs: BatchJobDefinition<any>[];
  /** When set, requests must carry this value in the `passphrase` header. */
  passphrase?: string;
}

/**
 * Netlify Functions 2.0 handler for a Hasura action shaped
 * `createBatchjob(trigger_type: String!, input: jsonb): { id }`. Looks the
 * trigger_type up among the service's OWN definitions, validates through the same
 * codec `createBatchJob` uses, inserts, and returns the new row id — so the
 * GraphQL surface can never create a batch job the service doesn't handle or an
 * input its codec rejects.
 */
export function batchJobsActionHandler(config: BatchJobsActionConfig): (req: Request) => Promise<Response> {
  const { executor, batchjobs, passphrase } = config;
  const byType = new Map(batchjobs.map(d => [d.triggerType, d]));

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return json(405, { message: 'Method Not Allowed' });
    if (passphrase !== undefined && req.headers.get('passphrase') !== passphrase) {
      return json(401, { message: 'Unauthorized' });
    }

    let body: { input?: { trigger_type?: string; input?: unknown } };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json(400, { message: 'Invalid JSON body' });
    }

    const triggerType = body?.input?.trigger_type;
    if (!triggerType) return json(400, { message: 'trigger_type is required' });
    const def = byType.get(triggerType);
    if (!def) {
      return json(400, { message: `Unknown trigger_type '${triggerType}' — this service does not define it` });
    }

    try {
      const result = await createBatchJob(executor, def, body.input?.input as never);
      return json(200, { id: result.id });
    } catch (err) {
      // Codec rejections surface as 400s naming the problem; transport errors as 500s.
      const message = err instanceof Error ? err.message : String(err);
      const isValidation = err instanceof Error && err.name !== 'Error' ? true : /invalid|expected|required/i.test(message);
      return json(isValidation ? 400 : 500, { message });
    }
  };
}
