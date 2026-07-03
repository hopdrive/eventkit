#!/usr/bin/env node
/**
 * EventKit Console — deterministic local seeder (Phase C1)
 *
 * Zero-dependency Node script. Generates realistic invocations /
 * event_executions / job_executions rows directly into the local
 * `event_detector_observability` Postgres database (via `docker exec
 * psql`), TRUNCATE-ing the three tables first so each run produces a
 * clean, reproducible dataset (deterministic PRNG — no faker, no
 * network calls). See docs/planning/console-migration-plan.md §8.
 *
 * Data shape:
 *   - invocations: ~15% are "children" — same correlation_id as a parent
 *     invocation, with source_job_id pointing at the specific
 *     job_executions row that (conceptually) spawned them. This is the
 *     correlation-chain the Flow page renders.
 *   - event_executions: ~12 "not_detected" + 1-3 "detected" per
 *     invocation, mirroring the real ~245-detector-checked-per-invocation
 *     shape without generating all 245 rows.
 *   - job_executions: 1-3 per detected event; mostly completed, ~2%
 *     failed (with error_message/error_stack).
 *   - source_event_payload: 2-10KB JSONB shaped like a real Hasura event
 *     ({event:{op,data:{old,new}},table:{schema,name}}), with a smaller
 *     share of webhook/cron/manual-shaped payloads for variety.
 *   - created_at skewed toward the recent end of a 30-day window.
 *
 * Perf note: rows are streamed straight to per-table COPY body files as
 * they're generated (never buffered as JS arrays) — at 100k+ invocations,
 * building full `invocations`/`event_executions`/`job_executions` arrays
 * in memory before writing blew past an 8GB heap (millions of multi-KB
 * JSONB payload objects, plus a per-invocation full shuffle+copy of a
 * 245-element pool). The streaming approach + a swap-based partial
 * sampler keep peak memory to a small, bounded set of "chain anchor" and
 * "child link" records regardless of --invocations size.
 *
 * Usage:
 *   node db/seed/seed.mjs [--invocations 5000] [--seed 20260701]
 *
 * Env overrides: same as db/local-setup.mjs (POSTGRES_CONTAINER, etc).
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_NAME, POSTGRES_CONTAINER, getLocalCredentials } from '../lib/db-creds.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function log(...args) {
  console.log('[seed]', ...args);
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { invocations: 5000, seed: 20260701 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--invocations') args.invocations = parseInt(argv[++i], 10);
    else if (argv[i] === '--seed') args.seed = parseInt(argv[++i], 10);
  }
  if (!Number.isFinite(args.invocations) || args.invocations < 1) {
    throw new Error('--invocations must be a positive integer');
  }
  return args;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) + helpers built on it. No Math.random(),
// no external deps — same --seed always produces the same dataset.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const rand = mulberry32(seed);
  return {
    float: () => rand(),
    int: (min, max) => min + Math.floor(rand() * (max - min + 1)),
    bool: (pTrue = 0.5) => rand() < pTrue,
    pick: arr => arr[Math.floor(rand() * arr.length)],
    weightedPick: weightedArr => {
      // weightedArr: [[value, weight], ...]
      const total = weightedArr.reduce((s, [, w]) => s + w, 0);
      let r = rand() * total;
      for (const [value, weight] of weightedArr) {
        r -= weight;
        if (r <= 0) return value;
      }
      return weightedArr[weightedArr.length - 1][0];
    },
    shuffle: arr => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    uuid: () => {
      // Deterministic, valid-format UUID v4 (version/variant bits set) built
      // from the seeded PRNG — not cryptographically random, which is fine
      // for reproducible fixture data.
      const hex = () => Math.floor(rand() * 16).toString(16);
      const bytes = Array.from({ length: 32 }, hex);
      bytes[12] = '4'; // version 4
      bytes[16] = ['8', '9', 'a', 'b'][Math.floor(rand() * 4)]; // variant
      const s = bytes.join('');
      return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
    },
    string: len => {
      const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let out = '';
      for (let i = 0; i < len; i++) out += chars[Math.floor(rand() * chars.length)];
      return out;
    },
  };
}

/**
 * Fast, bounded-cost padding string generator. The naive char-by-char
 * builder (`rng.string(len)` for len up to ~10,000) is fine for one-off
 * strings but at 200k+ invocations it's the single largest source of
 * per-invocation allocation. Generate a small random chunk (<=512 chars)
 * and repeat/slice it out to the target length — the padding's job is to
 * hit realistic JSONB byte sizes, not to be maximally random.
 */
function fastPadding(rng, len) {
  if (len <= 0) return '';
  const chunkLen = Math.min(len, 512);
  const chunk = rng.string(chunkLen);
  if (len <= chunkLen) return chunk.slice(0, len);
  return chunk.repeat(Math.ceil(len / chunkLen)).slice(0, len);
}

/**
 * Sample `count` distinct elements from `pool` in O(count) via a partial
 * Fisher-Yates swap on a single scratch copy of the pool, reused across
 * every call. Replaces the previous `rng.shuffle(pool).slice(0, count)`
 * pattern, which allocated + fully shuffled a fresh copy of the *entire*
 * pool on every invocation (245 elements x 200k invocations = tens of
 * millions of element copies of pure GC churn for a 12-element draw).
 * The scratch array's order keeps rolling between calls, which is fine —
 * each call still produces a uniform random `count`-subset of `pool`.
 */
function makeSampler(pool) {
  const scratch = pool.slice();
  const n = scratch.length;
  return (rng, count) => {
    const k = Math.min(count, n);
    for (let i = 0; i < k; i++) {
      const j = rng.int(i, n - 1);
      [scratch[i], scratch[j]] = [scratch[j], scratch[i]];
    }
    return scratch.slice(0, k);
  };
}

// ---------------------------------------------------------------------------
// Real-ish HopDrive name distributions
// ---------------------------------------------------------------------------
const DETECTED_EVENT_POOL = [
  ['move.pickup.started', 6],
  ['move.delivery.successful', 6],
  ['appointment.ready', 5],
  ['batch.created.ap', 3],
  ['invoice.closed', 3],
  ['move.delivery.started', 4],
  ['move.pickup.successful', 4],
  ['move.cancel.succeeded', 2],
  ['appointment.confirmed', 3],
  ['appointment.cancelled', 2],
  ['batch.closed.ap', 2],
  ['invoice.created', 2],
  ['driver.assigned', 3],
  ['driver.location.updated', 2],
];

const JOB_NAME_POOL = [
  ['runAR', 8],
  ['runARV2', 6],
  ['publishGenericWebhook', 7],
  ['sendDriverSilentPushNotification', 5],
  ['publishEventLog', 9],
  ['runDriverPay', 4],
];

const ENTITIES = ['move', 'appointment', 'batch', 'invoice', 'driver', 'dealer', 'customer', 'vehicle', 'payment', 'notification'];
const ACTIONS = [
  'created', 'updated', 'cancelled', 'started', 'completed', 'failed', 'assigned', 'requested',
  'confirmed', 'rejected', 'expired', 'retried', 'seen', 'pending', 'change', 'succeeded',
  'disputed', 'settled', 'partial', 'closed',
];

/** Build a deterministic pool of ~245 synthetic "detector" event names (the undetected majority). */
function buildUndetectedEventPool(rng) {
  const combos = [];
  for (const entity of ENTITIES) {
    for (const action of ACTIONS) {
      combos.push(`${entity}.${action}`);
      combos.push(`${entity}.${action}.change`);
    }
  }
  const shuffled = rng.shuffle(combos);
  return shuffled.slice(0, 245);
}

const SOURCE_TABLES = {
  move: 'moves',
  appointment: 'appointments',
  batch: 'batches',
  invoice: 'invoices',
  driver: 'drivers',
};

// ---------------------------------------------------------------------------
// Payload generation (2-10KB, shaped like a real Hasura event)
// ---------------------------------------------------------------------------
function buildDomainRow(rng, recordId) {
  return {
    id: recordId,
    status: rng.pick(['pending', 'active', 'completed', 'cancelled']),
    active: rng.bool(0.8) ? 1 : 0,
    lane_id: rng.int(1, 40),
    customer_id: rng.int(1, 500),
    driver_id: rng.bool(0.7) ? rng.int(1, 800) : null,
    priority: rng.int(1, 10),
    payable: rng.bool(0.9),
    settled: rng.bool(0.3),
    disputed: rng.bool(0.05),
    pickup_time: new Date(Date.now() - rng.int(0, 30) * 86400000).toISOString(),
    delivery_time: rng.bool(0.6) ? new Date(Date.now() - rng.int(0, 29) * 86400000).toISOString() : null,
    created_at: new Date(Date.now() - rng.int(0, 30) * 86400000).toISOString(),
    updated_at: new Date().toISOString(),
    reference_num: `REF-${rng.int(100000, 999999)}`,
    vehicle_vin: rng.string(17).toUpperCase(),
    vehicle_make: rng.pick(['Ford', 'Toyota', 'Honda', 'Chevrolet', 'Tesla', 'BMW']),
    vehicle_model: rng.pick(['F-150', 'Camry', 'Civic', 'Silverado', 'Model 3', 'X5']),
    vehicle_year: rng.int(2015, 2026),
    tags: null,
    config: null,
    workflow_data: null,
    cancel_reason: null,
    dispute_reason: null,
  };
}

function buildPayload(rng, { table, operation, recordId, source_system }) {
  const base = { id: rng.uuid(), created_at: new Date().toISOString() };

  if (source_system === 'hasura') {
    const newRow = operation === 'DELETE' ? null : buildDomainRow(rng, recordId);
    const oldRow = operation === 'INSERT' ? null : buildDomainRow(rng, recordId);
    Object.assign(base, {
      event: {
        op: operation,
        data: { old: oldRow, new: newRow },
        trace_context: { span_id: rng.string(16), trace_id: rng.string(32) },
        session_variables: { 'x-hasura-role': 'admin' },
      },
      table: { schema: 'public', name: table },
      trigger: { name: `event_detector_${table}` },
    });
  } else if (source_system.startsWith('webhook:')) {
    const vendor = source_system.split(':')[1];
    Object.assign(base, {
      source: 'webhook',
      vendor,
      event: {
        type: `${vendor}.callback`,
        payload: { object: { id: `${vendor}_${rng.string(14)}`, record_id: recordId, status: rng.pick(['succeeded', 'pending', 'failed']) } },
      },
    });
  } else {
    // cron / manual / action-style payload (no event.data.new — see bug B2)
    Object.assign(base, {
      source: source_system,
      event: { type: source_system, name: `${source_system}-task-${rng.int(1, 999)}` },
    });
  }

  // Pad to the target 2-10KB size with a deterministic filler string so the
  // payload matches real prod scale without hand-authoring huge fixtures.
  const targetSize = rng.int(2000, 10000);
  const currentSize = JSON.stringify(base).length;
  if (currentSize < targetSize) {
    base._seed_padding = fastPadding(rng, targetSize - currentSize - 20);
  }
  return base;
}

// ---------------------------------------------------------------------------
// COPY (text format) escaping
// ---------------------------------------------------------------------------
function copyField(value) {
  if (value === null || value === undefined) return '\\N';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function copyRow(values) {
  return values.map(copyField).join('\t') + '\n';
}

function isoOrNull(v) {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : v;
}

// ---------------------------------------------------------------------------
// Backpressure-aware line writer: write() returns a Promise only when the
// stream's internal buffer is full, so the hot loop doesn't pay a
// per-line await in the common case (millions of rows at 200k+ scale).
// ---------------------------------------------------------------------------
function makeLineWriter(stream) {
  let streamError = null;
  stream.once('error', err => {
    streamError = err;
  });
  return line => {
    if (streamError) throw streamError;
    const ok = stream.write(line);
    if (ok) return null;
    return new Promise(resolve => stream.once('drain', resolve));
  };
}

function closeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end(err => (err ? reject(err) : resolve()));
  });
}

/** Reservoir sampler bounded to `capacity` items — gives a uniform random subset of everything seen, with O(1) memory regardless of how many items are offered. */
function makeReservoir(rng, capacity) {
  const items = [];
  let seen = 0;
  return {
    offer(item) {
      seen++;
      if (items.length < capacity) {
        items.push(item);
      } else {
        const j = rng.int(0, seen - 1);
        if (j < capacity) items[j] = item;
      }
    },
    pick() {
      return items[rng.int(0, items.length - 1)];
    },
    get size() {
      return items.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming generation — writes COPY body lines directly to per-table temp
// files as rows are generated. Never holds the full dataset in memory;
// only a bounded reservoir of "chain anchor" jobs (for wiring up children)
// and a small list of child (invocation_id, source_job_id) links (for the
// final linking UPDATE) are retained.
// ---------------------------------------------------------------------------
const CHAIN_ANCHOR_RESERVOIR_CAPACITY = 20000;

async function generateStreaming(rng, invocationCount, writers) {
  const { writeInv, writeEv, writeJob } = writers;
  const undetectedPool = buildUndetectedEventPool(rng);
  const sampleUndetected = makeSampler(undetectedPool);
  const sampleDetectedNames = makeSampler(DETECTED_EVENT_POOL.map(([n]) => n));

  const numChildren = Math.round(invocationCount * 0.15);
  const numRoots = invocationCount - numChildren;

  const anchors = makeReservoir(rng, CHAIN_ANCHOR_RESERVOIR_CAPACITY);
  const childLinks = [];

  let recordIdCounter = 1000;
  let invocationTotal = 0;
  let eventTotal = 0;
  let jobTotal = 0;

  /** Generates + writes event/job rows for one invocation; mutates invocation's aggregate count fields and offers completed jobs to the anchor reservoir. */
  async function generateEventsAndJobsFor(invocation) {
    let eventsDetectedCount = 0;
    let totalJobsRun = 0;
    let totalJobsSucceeded = 0;
    let totalJobsFailed = 0;

    // ~12 undetected events
    const sampledUndetected = sampleUndetected(rng, 12);
    for (const eventName of sampledUndetected) {
      const p = writeEv(
        copyRow([rng.uuid(), invocation.id, invocation.correlation_id, eventName, false, 'not_detected', 0, 0, 0, isoOrNull(invocation.created_at)])
      );
      if (p) await p;
      eventTotal++;
    }

    // 1-3 detected events
    const detectedCount = rng.int(1, 3);
    const chosenDetected = sampleDetectedNames(rng, detectedCount);
    for (const eventName of chosenDetected) {
      eventsDetectedCount++;
      const eventId = rng.uuid();
      const jobsForEvent = rng.int(1, 3);
      let jobsSucceeded = 0;
      let jobsFailed = 0;

      for (let j = 0; j < jobsForEvent; j++) {
        const jobName = rng.weightedPick(JOB_NAME_POOL);
        const failed = rng.bool(0.02);
        const status = failed ? 'failed' : 'completed';
        if (failed) jobsFailed++;
        else jobsSucceeded++;
        totalJobsRun++;
        if (failed) totalJobsFailed++;
        else totalJobsSucceeded++;

        const jobId = rng.uuid();
        const jp = writeJob(
          copyRow([
            jobId,
            invocation.id,
            eventId,
            invocation.correlation_id,
            jobName,
            jobName,
            JSON.stringify({ retries: rng.int(0, 3) }),
            rng.int(20, 4000),
            status,
            failed ? null : { ok: true, id: rng.int(1, 100000) },
            failed ? `${jobName} failed: upstream timeout` : null,
            failed ? `Error: upstream timeout\n    at ${jobName} (jobs/${jobName}.ts:${rng.int(10, 300)}:${rng.int(1, 40)})` : null,
            isoOrNull(invocation.created_at),
          ])
        );
        if (jp) await jp;
        jobTotal++;

        if (status === 'completed') {
          anchors.offer({
            invocationId: invocation.id,
            jobExecutionId: jobId,
            correlationId: invocation.correlation_id,
            createdAt: invocation.created_at,
          });
        }
      }

      const ep = writeEv(
        copyRow([
          eventId,
          invocation.id,
          invocation.correlation_id,
          eventName,
          true,
          jobsFailed > 0 ? 'failed' : 'completed',
          jobsForEvent,
          jobsSucceeded,
          jobsFailed,
          isoOrNull(invocation.created_at),
        ])
      );
      if (ep) await ep;
      eventTotal++;
    }

    invocation.events_detected_count = eventsDetectedCount;
    invocation.total_jobs_run = totalJobsRun;
    invocation.total_jobs_succeeded = totalJobsSucceeded;
    invocation.total_jobs_failed = totalJobsFailed;
  }

  async function writeInvocationRow(invocation) {
    const p = writeInv(
      copyRow([
        invocation.id,
        isoOrNull(invocation.created_at),
        isoOrNull(invocation.updated_at),
        invocation.correlation_id,
        invocation.source_function,
        invocation.source_table,
        invocation.source_operation,
        invocation.source_system,
        invocation.source_event_id,
        JSON.stringify(invocation.source_event_payload),
        isoOrNull(invocation.source_event_time),
        invocation.source_user_email,
        invocation.source_user_role,
        invocation.total_duration_ms,
        invocation.events_detected_count,
        invocation.total_jobs_run,
        invocation.total_jobs_succeeded,
        invocation.total_jobs_failed,
        invocation.auto_load_modules,
        invocation.event_modules_directory,
        invocation.status,
        invocation.error_message,
        invocation.error_stack,
        invocation.context_data,
      ])
    );
    if (p) await p;
    invocationTotal++;
  }

  function skewedDayOffset() {
    // Skewed toward recent days: pow > 1 pulls the [0,1) sample toward 0.
    return Math.floor(30 * Math.pow(rng.float(), 1.6));
  }

  function randomTimeOnDay(dayOffset) {
    const now = Date.now();
    const dayMs = dayOffset * 86400000;
    const jitterMs = rng.int(0, 86400000 - 1);
    return new Date(now - dayMs - jitterMs);
  }

  const progressEvery = Math.max(1, Math.floor(invocationCount / 10));

  // --- Roots ---
  for (let i = 0; i < numRoots; i++) {
    const entity = rng.pick(Object.keys(SOURCE_TABLES));
    const table = SOURCE_TABLES[entity];
    const operation = rng.weightedPick([['INSERT', 3], ['UPDATE', 6], ['DELETE', 1]]);
    const sourceSystem = rng.weightedPick([['hasura', 8], ['webhook:stripe', 1], ['webhook:runar', 1], ['cron', 0.5], ['manual', 0.5]]);
    const sourceFunction = 'event-handlers';
    const correlationId = `${sourceFunction}.${rng.uuid()}`;
    const dayOffset = skewedDayOffset();
    const createdAt = randomTimeOnDay(dayOffset);
    const recordId = recordIdCounter++;
    const status = rng.weightedPick([['completed', 93], ['failed', 5], ['running', 2]]);

    const invocation = {
      id: rng.uuid(),
      created_at: createdAt,
      updated_at: createdAt,
      correlation_id: correlationId,
      source_function: sourceFunction,
      source_table: sourceSystem === 'hasura' ? `public.${table}` : null,
      source_operation: sourceSystem === 'hasura' ? operation : sourceSystem === 'cron' ? 'MANUAL' : 'MANUAL',
      source_system: sourceSystem,
      source_job_id: null, // always NULL on the initial COPY; see the final linking UPDATE below
      source_event_id: rng.uuid(),
      source_event_payload: buildPayload(rng, { table, operation, recordId, source_system: sourceSystem }),
      source_event_time: createdAt,
      source_user_email: rng.bool(0.4) ? rng.pick(['ops@hopdrive.com', 'dispatch@hopdrive.com', 'system@hopdrive.com']) : null,
      source_user_role: rng.bool(0.4) ? 'admin' : null,
      total_duration_ms: rng.int(50, 8000),
      auto_load_modules: true,
      event_modules_directory: null,
      status,
      error_message: status === 'failed' ? 'Unhandled exception during event detection' : null,
      error_stack: status === 'failed' ? `Error: Unhandled exception\n    at detectEvents (index.ts:${rng.int(10, 200)}:${rng.int(1, 40)})` : null,
      context_data: null,
    };

    await generateEventsAndJobsFor(invocation);
    await writeInvocationRow(invocation);

    if ((i + 1) % progressEvery === 0) log(`  roots: ${i + 1}/${numRoots}`);
  }

  // --- Children (~15%), each chained onto a random completed job from a root ---
  for (let i = 0; i < numChildren; i++) {
    if (anchors.size === 0) break; // no completed jobs yet (degenerate case with tiny --invocations)
    const anchor = anchors.pick();
    const entity = rng.pick(Object.keys(SOURCE_TABLES));
    const table = SOURCE_TABLES[entity];
    const operation = rng.weightedPick([['UPDATE', 6], ['INSERT', 3], ['DELETE', 1]]);
    const isVendorRoundTrip = rng.bool(0.5);
    const sourceSystem = isVendorRoundTrip ? rng.pick(['webhook:stripe', 'webhook:runar']) : 'hasura';
    const sourceFunction = 'event-handlers';
    const recordId = recordIdCounter++;
    // Child fires shortly after the parent job completed.
    const createdAt = new Date(new Date(anchor.createdAt).getTime() + rng.int(1000, 60000));
    const status = rng.weightedPick([['completed', 93], ['failed', 5], ['running', 2]]);

    const invocation = {
      id: rng.uuid(),
      created_at: createdAt,
      updated_at: createdAt,
      correlation_id: anchor.correlationId, // same correlation_id as the parent chain
      source_function: sourceFunction,
      source_table: sourceSystem === 'hasura' ? `public.${table}` : null,
      source_operation: sourceSystem === 'hasura' ? operation : 'MANUAL',
      source_system: sourceSystem,
      source_job_id: null, // linked via UPDATE below, after job_executions exists
      source_event_id: rng.uuid(),
      source_event_payload: buildPayload(rng, { table, operation, recordId, source_system: sourceSystem }),
      source_event_time: createdAt,
      source_user_email: null,
      source_user_role: null,
      total_duration_ms: rng.int(50, 8000),
      auto_load_modules: true,
      event_modules_directory: null,
      status,
      error_message: status === 'failed' ? 'Unhandled exception during event detection' : null,
      error_stack: status === 'failed' ? `Error: Unhandled exception\n    at detectEvents (index.ts:${rng.int(10, 200)}:${rng.int(1, 40)})` : null,
      context_data: null,
    };

    await generateEventsAndJobsFor(invocation);
    await writeInvocationRow(invocation);
    childLinks.push({ id: invocation.id, sourceJobId: anchor.jobExecutionId });

    if ((i + 1) % progressEvery === 0) log(`  children: ${i + 1}/${numChildren}`);
  }

  return { invocationTotal, eventTotal, jobTotal, childLinks };
}

// ---------------------------------------------------------------------------
// Assembling the final SQL script: header/footer + streamed-in body files.
// The body files (already-formatted COPY lines) are piped straight through
// rather than read into memory, so assembly cost is O(disk throughput),
// not O(dataset size in JS heap).
// ---------------------------------------------------------------------------
function pipeFileInto(srcPath, destStream) {
  return new Promise((resolve, reject) => {
    const src = createReadStream(srcPath);
    src.on('error', reject);
    destStream.on('error', reject);
    src.pipe(destStream, { end: false });
    src.on('end', resolve);
  });
}

// Non-PK performance indexes from schema.sql, dropped before the bulk COPY
// and rebuilt after. Incrementally maintaining 18 indexes across ~3.8M rows
// during COPY was the dominant cost at 200k invocations (~11.5 minutes wall
// clock against ~25s of actual JS generation time) — building each index
// once against already-loaded data is far cheaper than updating all of them
// per inserted row.
const PERF_INDEXES = [
  ['idx_invocations_created_at', 'CREATE INDEX idx_invocations_created_at ON invocations(created_at DESC);'],
  ['idx_invocations_source_function', 'CREATE INDEX idx_invocations_source_function ON invocations(source_function);'],
  ['idx_invocations_source_system', 'CREATE INDEX idx_invocations_source_system ON invocations(source_system);'],
  ['idx_invocations_status', 'CREATE INDEX idx_invocations_status ON invocations(status);'],
  ['idx_invocations_source_event_id', 'CREATE INDEX idx_invocations_source_event_id ON invocations(source_event_id);'],
  ['idx_invocations_correlation_id', 'CREATE INDEX idx_invocations_correlation_id ON invocations(correlation_id);'],
  ['idx_invocations_source_job_id', 'CREATE INDEX idx_invocations_source_job_id ON invocations(source_job_id);'],
  ['idx_event_executions_invocation_id', 'CREATE INDEX idx_event_executions_invocation_id ON event_executions(invocation_id);'],
  ['idx_event_executions_event_name', 'CREATE INDEX idx_event_executions_event_name ON event_executions(event_name);'],
  ['idx_event_executions_detected', 'CREATE INDEX idx_event_executions_detected ON event_executions(detected);'],
  ['idx_event_executions_status', 'CREATE INDEX idx_event_executions_status ON event_executions(status);'],
  ['idx_event_executions_correlation_id', 'CREATE INDEX idx_event_executions_correlation_id ON event_executions(correlation_id);'],
  ['idx_job_executions_invocation_id', 'CREATE INDEX idx_job_executions_invocation_id ON job_executions(invocation_id);'],
  ['idx_job_executions_event_execution_id', 'CREATE INDEX idx_job_executions_event_execution_id ON job_executions(event_execution_id);'],
  ['idx_job_executions_job_name', 'CREATE INDEX idx_job_executions_job_name ON job_executions(job_name);'],
  ['idx_job_executions_status', 'CREATE INDEX idx_job_executions_status ON job_executions(status);'],
  ['idx_job_executions_created_at', 'CREATE INDEX idx_job_executions_created_at ON job_executions(created_at DESC);'],
  ['idx_job_executions_correlation_id', 'CREATE INDEX idx_job_executions_correlation_id ON job_executions(correlation_id);'],
];

async function assembleFinalScript({ finalPath, invBodyPath, evBodyPath, jobBodyPath, childLinks }) {
  const out = createWriteStream(finalPath, { encoding: 'utf8' });
  const write = s => new Promise((resolve, reject) => out.write(s, err => (err ? reject(err) : resolve())));

  await write('BEGIN;\n');
  await write('SET LOCAL maintenance_work_mem = \'512MB\';\n');
  for (const [name] of PERF_INDEXES) {
    await write(`DROP INDEX IF EXISTS ${name};\n`);
  }
  await write('TRUNCATE TABLE invocations, event_executions, job_executions RESTART IDENTITY CASCADE;\n');

  await write(
    'COPY invocations (id, created_at, updated_at, correlation_id, source_function, source_table, source_operation, source_system, source_event_id, source_event_payload, source_event_time, source_user_email, source_user_role, total_duration_ms, events_detected_count, total_jobs_run, total_jobs_succeeded, total_jobs_failed, auto_load_modules, event_modules_directory, status, error_message, error_stack, context_data) FROM STDIN;\n'
  );
  await pipeFileInto(invBodyPath, out);
  await write('\\.\n');

  await write(
    'COPY event_executions (id, invocation_id, correlation_id, event_name, detected, status, jobs_count, jobs_succeeded, jobs_failed, created_at) FROM STDIN;\n'
  );
  await pipeFileInto(evBodyPath, out);
  await write('\\.\n');

  await write(
    'COPY job_executions (id, invocation_id, event_execution_id, correlation_id, job_name, job_function_name, job_options, duration_ms, status, result, error_message, error_stack, created_at) FROM STDIN;\n'
  );
  await pipeFileInto(jobBodyPath, out);
  await write('\\.\n');

  // Second pass: wire up source_job_id for chained ("child") invocations now
  // that job_executions exist. Done as a single batched UPDATE ... FROM
  // VALUES rather than N individual UPDATEs — avoids the invocations <->
  // job_executions insertion-order problem (invocations.source_job_id
  // references job_executions.id, but the invocations COPY block runs
  // before job_executions exists) without touching the schema.
  if (childLinks.length > 0) {
    await write('UPDATE invocations i SET source_job_id = v.job_id::uuid FROM (VALUES\n');
    const rows = childLinks.map(link => `  ('${link.id}'::uuid, '${link.sourceJobId}'::uuid)`);
    await write(rows.join(',\n'));
    await write('\n) AS v(inv_id, job_id) WHERE i.id = v.inv_id;\n');
  }

  for (const [, createStatement] of PERF_INDEXES) {
    await write(`${createStatement}\n`);
  }
  await write('ANALYZE invocations, event_executions, job_executions;\n');

  await write('COMMIT;\n');
  await closeStream(out);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
function runSqlFileInContainer(pgUser, hostFilePath) {
  const containerPath = '/tmp/eventkit-seed.sql';
  execFileSync('docker', ['cp', hostFilePath, `${POSTGRES_CONTAINER}:${containerPath}`]);
  try {
    execFileSync('docker', ['exec', POSTGRES_CONTAINER, 'psql', '-U', pgUser, '-d', DB_NAME, '-v', 'ON_ERROR_STOP=1', '-f', containerPath], {
      stdio: 'inherit',
    });
  } finally {
    execFileSync('docker', ['exec', POSTGRES_CONTAINER, 'rm', '-f', containerPath]);
  }
}

function countRows(pgUser, table) {
  const out = execFileSync('docker', ['exec', POSTGRES_CONTAINER, 'psql', '-U', pgUser, '-d', DB_NAME, '-tAc', `SELECT count(*) FROM ${table}`], {
    encoding: 'utf8',
  });
  return out.trim();
}

async function main() {
  const { invocations: invocationCount, seed } = parseArgs(process.argv.slice(2));
  log(`Generating ${invocationCount} invocations (seed=${seed})...`);

  const { pgUser } = getLocalCredentials(__dirname);

  const rng = makeRng(seed);

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'eventkit-console-seed-'));
  const invBodyPath = path.join(tmpDir, 'invocations.copy');
  const evBodyPath = path.join(tmpDir, 'event_executions.copy');
  const jobBodyPath = path.join(tmpDir, 'job_executions.copy');
  const finalPath = path.join(tmpDir, 'seed.sql');

  const invStream = createWriteStream(invBodyPath);
  const evStream = createWriteStream(evBodyPath);
  const jobStream = createWriteStream(jobBodyPath);

  const { invocationTotal, eventTotal, jobTotal, childLinks } = await generateStreaming(rng, invocationCount, {
    writeInv: makeLineWriter(invStream),
    writeEv: makeLineWriter(evStream),
    writeJob: makeLineWriter(jobStream),
  });

  await Promise.all([closeStream(invStream), closeStream(evStream), closeStream(jobStream)]);

  log(`Generated ${invocationTotal} invocations, ${eventTotal} event_executions, ${jobTotal} job_executions.`);
  log(`Assembling SQL script at ${finalPath}...`);
  await assembleFinalScript({ finalPath, invBodyPath, evBodyPath, jobBodyPath, childLinks });

  log('Loading into the database (TRUNCATE + COPY, single transaction)...');
  runSqlFileInContainer(pgUser, finalPath);
  rmSync(tmpDir, { recursive: true, force: true });

  log('Done. Row counts:');
  log(`  invocations:       ${countRows(pgUser, 'invocations')}`);
  log(`  event_executions:  ${countRows(pgUser, 'event_executions')}`);
  log(`  job_executions:    ${countRows(pgUser, 'job_executions')}`);
}

main().catch(err => {
  console.error('[seed] FAILED:', err);
  process.exit(1);
});
