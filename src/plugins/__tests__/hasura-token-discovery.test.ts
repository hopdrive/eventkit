// Inbound tracking-token discovery (ADR-039.2): a Hasura source surfaces ordered
// `meta.tokenCandidates` during normalize, from the row write field then session
// variables. Config lives on the SOURCE (the factory / second arg of createEventKit).
import { describe, it, expect } from 'vitest';
import { createEventKit, defineEvent, job, type EventKitPlugin, type JobContext } from '../../index.js';
import { hasuraEvent, hasuraAction, hasuraCron } from '../source-hasura.js';
import { collectTokenCandidates } from '../source-hasura.js';
import type { HasuraActionPayload, HasuraCronPayload, HasuraEventPayload, HasuraOperation } from '../hasura-shared/types.js';

type Row = Record<string, unknown>;

function eventPayload(
  op: HasuraOperation,
  newRow: Row | null,
  session?: Record<string, string>,
): HasuraEventPayload {
  return {
    id: 'evt-1',
    created_at: '2026-06-28T12:00:00.000Z',
    trigger: { name: 'appointments' },
    table: { schema: 'public', name: 'appointments' },
    event: {
      op,
      data: { old: null, new: newRow },
      session_variables: session ?? { 'x-hasura-role': 'admin' },
    },
    delivery_info: { max_retries: 0, current_retry: 0 },
  };
}

const metaOf = (env: { meta: Record<string, unknown> }) => env.meta as { tokenCandidates?: string[] };

describe('collectTokenCandidates', () => {
  it('orders write-field values first, then session variables; dedupes; skips empties', () => {
    const out = collectTokenCandidates(
      { updated_by: 'svc|corr|job', name: 'x' },
      { 'x-hasura-tracking-token': 'svc|corr2|job2' },
      {},
    );
    expect(out).toEqual(['svc|corr|job', 'svc|corr2|job2']);
  });

  it('checks updatedby / updated_by fallbacks after the configured field', () => {
    const out = collectTokenCandidates({ modified_by: 'a', updatedby: 'b', updated_by: 'c' }, null, {
      tokenField: 'modified_by',
    });
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array when nothing is found', () => {
    expect(collectTokenCandidates(null, null, {})).toEqual([]);
    expect(collectTokenCandidates({ other: 'x' }, { 'x-hasura-role': 'admin' }, {})).toEqual([]);
  });
});

describe('hasuraEvent.normalize surfaces meta.tokenCandidates', () => {
  it('default config: [updated_by value, x-hasura-tracking-token value] in order', () => {
    const env = hasuraEvent.normalize!(
      eventPayload('UPDATE', { updated_by: 'svc|corr|job' }, { 'x-hasura-tracking-token': 'svc|corr2|job2' }),
      {},
    );
    expect(metaOf(env).tokenCandidates).toEqual(['svc|corr|job', 'svc|corr2|job2']);
  });

  it('configured tokenField reads that field first', () => {
    const configured = hasuraEvent({ tokenField: 'modified_by' });
    const env = configured.normalize!(eventPayload('UPDATE', { modified_by: 'svc|corr|job' }), {});
    expect(metaOf(env).tokenCandidates).toEqual(['svc|corr|job']);
  });

  it('a payload with neither channel sets NO tokenCandidates key', () => {
    const env = hasuraEvent.normalize!(eventPayload('INSERT', { status: 'ready' }), {});
    expect('tokenCandidates' in env.meta).toBe(false);
  });
});

describe('hasuraAction.normalize surfaces a session-variable candidate', () => {
  it('reads the default session variable', () => {
    const payload: HasuraActionPayload = {
      action: { name: 'doThing' },
      input: {},
      session_variables: { 'x-hasura-role': 'admin', 'x-hasura-tracking-token': 'svc|corr|job' },
    };
    const env = hasuraAction.normalize!(payload, {});
    expect(metaOf(env).tokenCandidates).toEqual(['svc|corr|job']);
  });
});

describe('hasuraCron.normalize surfaces no candidates', () => {
  it('cron carries neither row nor session variables', () => {
    const payload: HasuraCronPayload = { name: 'nightly', scheduled_time: '2026-06-28T00:00:00.000Z', payload: {}, id: 'c1' };
    const env = hasuraCron.normalize!(payload, {});
    expect('tokenCandidates' in env.meta).toBe(false);
  });
});

describe('createEventKit(hasuraEvent, config) end to end', () => {
  it('the configured candidate reaches the envelope meta a job reads via ctx.envelope.meta', async () => {
    let seen: string[] | undefined;
    const mod = defineEvent({
      name: 'e',
      detector: hasuraEvent.detector(() => true),
      jobs: [
        job((c: JobContext) => void (seen = (c.envelope.meta as { tokenCandidates?: string[] }).tokenCandidates)),
      ],
    });
    const kit = createEventKit(hasuraEvent, { tokenField: 'modified_by' }).registerEvents([mod]);
    await kit.handle(eventPayload('UPDATE', { modified_by: 'svc|corr|job' }));
    expect(seen).toEqual(['svc|corr|job']);
  });

  it('a probe plugin sees the candidate on the augmentEnvelope input', async () => {
    let seen: string[] | undefined;
    const probe: EventKitPlugin = {
      name: 'probe',
      augmentEnvelope(env) {
        seen = (env.meta as { tokenCandidates?: string[] }).tokenCandidates;
        return undefined;
      },
    };
    const mod = defineEvent({ name: 'e', detector: hasuraEvent.detector(() => true), jobs: [job(() => 'ok')] });
    const kit = createEventKit(hasuraEvent).use(probe).registerEvents([mod]);
    await kit.handle(eventPayload('UPDATE', { updated_by: 'svc|corr|job' }, { 'x-hasura-tracking-token': 'svc|corr2|job2' }));
    expect(seen).toEqual(['svc|corr|job', 'svc|corr2|job2']);
  });
});
