import { describe, it, expect, vi } from 'vitest';
import { createEventKit, defineEvent, job, type JobContext } from '../../index.js';
import { hasuraEvent } from '../source-hasura.js';
import {
  batch,
  batchJob,
  createBatchJob,
  executorBatchJobStore,
  batchJobsActionHandler,
  type BatchJobGqlExecutor,
} from '../batch/index.js';

// Minimal Hasura DB-event payload builders for the batch_jobs table.
function insertRow(newRow: Record<string, unknown>, table = 'batch_jobs'): unknown {
  return {
    id: 'evt',
    created_at: '2026-07-20T12:00:00.000Z',
    table: { schema: 'public', name: table },
    trigger: { name: 'db-batchjobs' },
    event: { op: 'INSERT', data: { old: null, new: newRow }, session_variables: { 'x-hasura-role': 'admin' } },
  };
}

function updateRow(oldRow: Record<string, unknown>, newRow: Record<string, unknown>): unknown {
  return {
    id: 'evt',
    created_at: '2026-07-20T12:00:00.000Z',
    table: { schema: 'public', name: 'batch_jobs' },
    trigger: { name: 'db-batchjobs' },
    event: { op: 'UPDATE', data: { old: oldRow, new: newRow }, session_variables: { 'x-hasura-role': 'admin' } },
  };
}

/** Zod-shaped codec without the dependency: numbers-only `moveId`. */
const moveIdCodec = {
  parse(value: unknown): { moveId: number } {
    const v = value as { moveId?: unknown } | null | undefined;
    if (!v || typeof v.moveId !== 'number') throw new Error('Invalid input: expected { moveId: number }');
    return { moveId: v.moveId };
  },
};

/** Executor double: records every mutate and returns a canned insert result. */
function fakeExecutor(result: unknown = { insert_batch_jobs_one: { id: 42 } }) {
  const calls: { text: string; variables: Record<string, unknown> }[] = [];
  const executor: BatchJobGqlExecutor = {
    mutate: vi.fn(async (document: unknown, variables?: Record<string, unknown>) => {
      calls.push({ text: (document as { __text: string }).__text, variables: variables ?? {} });
      return result as never;
    }),
  };
  return { executor, calls };
}

describe('batchJob() definition', () => {
  const ar = batchJob({ triggerType: 'ar', input: moveIdCodec });

  const runKit = async (payload: unknown) => {
    const seen: unknown[] = [];
    const mod = defineEvent({
      name: 'batch.created.ar',
      detector: ar.detector,
      jobs: [job((ctx: JobContext<{ moveId: number }>) => void seen.push(ctx.input), { name: 'runAr', input: ar.input })],
    });
    const kit = createEventKit(hasuraEvent).registerEvents([mod]);
    await kit.handle(payload);
    return seen;
  };

  it('detects INSERT of its own trigger_type and parses row.input into ctx.input', async () => {
    const seen = await runKit(insertRow({ id: 1, trigger_type: 'ar', status: 'pending', input: { moveId: 770603 } }));
    expect(seen).toEqual([{ moveId: 770603 }]);
  });

  it('ignores other trigger_types and other tables', async () => {
    expect(await runKit(insertRow({ id: 2, trigger_type: 'ap', input: { moveId: 1 } }))).toEqual([]);
    expect(await runKit(insertRow({ id: 3, trigger_type: 'ar', input: { moveId: 1 } }, 'moves'))).toEqual([]);
  });

  it('fires on the UPDATE→pending replay path but not on other status flips', async () => {
    const replay = await runKit(
      updateRow(
        { id: 4, trigger_type: 'ar', status: 'error', input: { moveId: 9 } },
        { id: 4, trigger_type: 'ar', status: 'pending', input: { moveId: 9 } },
      ),
    );
    expect(replay).toEqual([{ moveId: 9 }]);

    const advance = await runKit(
      updateRow(
        { id: 5, trigger_type: 'ar', status: 'pending', input: { moveId: 9 } },
        { id: 5, trigger_type: 'ar', status: 'processing', input: { moveId: 9 } },
      ),
    );
    expect(advance).toEqual([]);
  });

  it('input mapper throws through the codec on malformed row input', () => {
    const ctx = { envelope: { payload: insertRow({ id: 6, trigger_type: 'ar', input: { moveId: 'nope' } }) } };
    expect(() => ar.input(ctx)).toThrow(/expected \{ moveId: number \}/);
  });

  it('passes input through untyped when no codec is given', () => {
    const loose = batchJob({ triggerType: 'csv' });
    const ctx = { envelope: { payload: insertRow({ id: 7, trigger_type: 'csv', input: { anything: true } }) } };
    expect(loose.input(ctx)).toEqual({ anything: true });
  });

  it('rejects an empty triggerType', () => {
    expect(() => batchJob({ triggerType: '' })).toThrow(/triggerType/);
  });
});

describe('createBatchJob()', () => {
  const ar = batchJob({ triggerType: 'ar', input: moveIdCodec });

  it('inserts a pending row with the definition trigger_type and validated input', async () => {
    const { executor, calls } = fakeExecutor();
    const result = await createBatchJob(executor, ar, { moveId: 770603 }, { delayMs: 20_000, uniqueKey: '770603', user: 'system' });

    expect(result).toEqual({ id: 42, deduped: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.variables['object']).toEqual({
      trigger_type: 'ar',
      status: 'pending',
      input: { moveId: 770603 },
      delay_ms: 20_000,
      delay_key: 'ar-770603',
      createdby: 'system',
    });
    // uniqueKey → the dedup mutation with the delay_key on_conflict
    expect(calls[0]!.text).toContain('on_conflict');
    expect(calls[0]!.text).toContain('batch_jobs_delay_key_key');
  });

  it('uses the plain insert (no on_conflict) when no uniqueKey is given', async () => {
    const { executor, calls } = fakeExecutor();
    await createBatchJob(executor, ar, { moveId: 1 });
    expect(calls[0]!.text).not.toContain('on_conflict');
    expect(calls[0]!.variables['object']).toEqual({ trigger_type: 'ar', status: 'pending', input: { moveId: 1 } });
  });

  it('reports dedup when the on_conflict insert returns null', async () => {
    const { executor } = fakeExecutor({ insert_batch_jobs_one: null });
    const result = await createBatchJob(executor, ar, { moveId: 1 }, { uniqueKey: '1' });
    expect(result).toEqual({ id: null, deduped: true });
  });

  it('rejects invalid input through the codec BEFORE any write', async () => {
    const { executor, calls } = fakeExecutor();
    await expect(createBatchJob(executor, ar, { moveId: 'bad' } as never)).rejects.toThrow(/expected \{ moveId: number \}/);
    expect(calls).toHaveLength(0);
  });
});

describe('executorBatchJobStore() + batch({ executor })', () => {
  it('update() stamps updatedat alongside the fields', async () => {
    const { executor, calls } = fakeExecutor({ update_batch_jobs_by_pk: { id: 7 } });
    await executorBatchJobStore(executor).update(7, { status: 'done', output: { ok: true } });
    const fields = calls[0]!.variables['fields'] as Record<string, unknown>;
    expect(calls[0]!.variables['id']).toBe(7);
    expect(fields['status']).toBe('done');
    expect(fields['output']).toEqual({ ok: true });
    expect(typeof fields['updatedat']).toBe('string');
  });

  it('enqueueDelayed() forms the delay_key and treats dedup as success', async () => {
    const { executor, calls } = fakeExecutor({ insert_batch_jobs_one: null });
    await expect(
      executorBatchJobStore(executor).enqueueDelayed({ triggerType: 'ar', uniqueKey: '9', delayMs: 5_000, input: { moveId: 9 } }),
    ).resolves.toBeUndefined();
    const object = calls[0]!.variables['object'] as Record<string, unknown>;
    expect(object['delay_key']).toBe('ar-9');
    expect(object['delay_ms']).toBe(5_000);
    expect(calls[0]!.text).toContain('on_conflict');
  });

  it('markStranded() returns true only when a row actually flipped', async () => {
    const flipped = fakeExecutor({ update_batch_jobs: { affected_rows: 1 } });
    const raced = fakeExecutor({ update_batch_jobs: { affected_rows: 0 } });
    await expect(executorBatchJobStore(flipped.executor).markStranded(1, { reason: 'x' })).resolves.toBe(true);
    await expect(executorBatchJobStore(raced.executor).markStranded(1, { reason: 'x' })).resolves.toBe(false);
  });

  it('batch({ executor }) builds the canonical store and moves the row through the lifecycle', async () => {
    const { executor, calls } = fakeExecutor({ update_batch_jobs_by_pk: { id: 11 } });
    const ar = batchJob({ triggerType: 'ar', input: moveIdCodec });
    const mod = defineEvent({
      name: 'batch.created.ar',
      detector: ar.detector,
      jobs: [job(() => 'done-result', { name: 'runAr', input: ar.input })],
    });
    const kit = createEventKit(hasuraEvent).use(batch, { executor }).registerEvents([mod]);
    await kit.handle(insertRow({ id: 11, trigger_type: 'ar', status: 'pending', input: { moveId: 1 } }));

    const statuses = calls.map(c => (c.variables['fields'] as Record<string, unknown>)['status']);
    expect(statuses[0]).toBe('processing');
    expect(statuses[statuses.length - 1]).toBe('done');
  });

  it('batch() without store or executor throws the combined guidance', () => {
    expect(() => batch({} as never)).toThrow(/store.*or an `executor`/);
  });
});

describe('batchJobsActionHandler()', () => {
  const ar = batchJob({ triggerType: 'ar', input: moveIdCodec });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request('https://svc.example/action-create-batchjob', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('creates a batch job for an owned trigger_type and returns the id', async () => {
    const { executor, calls } = fakeExecutor();
    const handler = batchJobsActionHandler({ executor, batchjobs: [ar] });
    const res = await handler(post({ input: { trigger_type: 'ar', input: { moveId: 770603 } } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 42 });
    expect((calls[0]!.variables['object'] as Record<string, unknown>)['trigger_type']).toBe('ar');
  });

  it('refuses trigger_types the service does not define', async () => {
    const { executor, calls } = fakeExecutor();
    const handler = batchJobsActionHandler({ executor, batchjobs: [ar] });
    const res = await handler(post({ input: { trigger_type: 'ap', input: {} } }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/does not define/);
    expect(calls).toHaveLength(0);
  });

  it('rejects codec-invalid input with a 400 naming the problem', async () => {
    const { executor, calls } = fakeExecutor();
    const handler = batchJobsActionHandler({ executor, batchjobs: [ar] });
    const res = await handler(post({ input: { trigger_type: 'ar', input: { moveId: 'bad' } } }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/expected \{ moveId: number \}/);
    expect(calls).toHaveLength(0);
  });

  it('enforces the passphrase header when configured', async () => {
    const { executor } = fakeExecutor();
    const handler = batchJobsActionHandler({ executor, batchjobs: [ar], passphrase: 's3cret' });
    expect((await handler(post({ input: { trigger_type: 'ar', input: { moveId: 1 } } }))).status).toBe(401);
    expect(
      (await handler(post({ input: { trigger_type: 'ar', input: { moveId: 1 } } }, { passphrase: 's3cret' }))).status,
    ).toBe(200);
  });

  it('rejects non-POST and malformed JSON', async () => {
    const { executor } = fakeExecutor();
    const handler = batchJobsActionHandler({ executor, batchjobs: [ar] });
    expect((await handler(new Request('https://x/', { method: 'GET' }))).status).toBe(405);
    const bad = new Request('https://x/', { method: 'POST', body: '{nope' });
    expect((await handler(bad)).status).toBe(400);
  });
});
