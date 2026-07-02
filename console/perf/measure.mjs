#!/usr/bin/env node
/**
 * EventKit Console — perf baseline harness (Phase C3 prep, plan §8).
 *
 * Drives the console with headless Chromium under CPU + network throttling
 * and measures the scenarios called out in the migration plan: cold loads,
 * search (keystroke + paste), facets, pagination, the detail drawer, the
 * flow diagram, and hidden-tab polling behavior. Each scenario runs 3 times
 * (fresh page per run) and reports the median wall time (via
 * `performance.now()` in this Node process, bracketing the Puppeteer calls)
 * plus GraphQL request count and bytes transferred captured via the Chrome
 * DevTools Protocol Network domain.
 *
 * Reads the app URL and Hasura admin secret from console/.env — never
 * hard-code secrets here. The admin secret is used only for a couple of
 * preflight GraphQL queries (finding a real correlation id / a chained
 * invocation id / current row counts) — the browser itself talks to
 * whatever the running app is configured with.
 *
 * Usage: node perf/measure.mjs
 * Output: perf/baseline.json (machine-readable) + an appended table in
 * PERF.md (human-readable), per docs/planning/console-migration-plan.md §8.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONSOLE_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(CONSOLE_DIR, '..');

// Local Hasura (gql.local.hopdrive.io) serves a mkcert-issued cert. Chromium
// consults the OS keychain and trusts it; Node's fetch (undici) doesn't, so
// the preflight GraphQL queries below would fail with
// UNABLE_TO_VERIFY_LEAF_SIGNATURE. Same fix as db/local-setup.mjs: re-exec
// once with NODE_EXTRA_CA_CERTS set (must be present before the process
// starts) rather than disabling TLS verification. See db/local-setup.mjs
// for the fuller explanation.
if (!process.env.NODE_EXTRA_CA_CERTS && !process.env.__PERF_REEXEC) {
  try {
    const caRoot = execFileSync('mkcert', ['-CAROOT'], { encoding: 'utf8' }).trim();
    const rootCaPath = path.join(caRoot, 'rootCA.pem');
    if (existsSync(rootCaPath)) {
      const result = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
        stdio: 'inherit',
        env: { ...process.env, NODE_EXTRA_CA_CERTS: rootCaPath, __PERF_REEXEC: '1' },
      });
      process.exit(result.status ?? 1);
    }
  } catch {
    // mkcert not installed / not on PATH — continue without it; the
    // preflight fetch calls below will surface a clear TLS error.
  }
}

const puppeteer = (await import('puppeteer')).default;

function log(...args) {
  console.log('[perf]', ...args);
}

// ---------------------------------------------------------------------------
// .env parsing — manual, no secrets ever hard-coded here.
// ---------------------------------------------------------------------------
function loadEnv(envPath) {
  const env = {};
  if (!fs.existsSync(envPath)) return env;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    env[key] = value;
  }
  return env;
}

const env = loadEnv(path.join(CONSOLE_DIR, '.env'));
const GRAPHQL_ENDPOINT = env.VITE_GRAPHQL_ENDPOINT;
const ADMIN_SECRET = env.VITE_HASURA_ADMIN_SECRET;
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
// Distinguishes which app target a run measured — e.g. 'dev-server' (vite
// dev, unbundled ES modules) vs 'production-build' (vite build + preview).
// Controls the output filename (perf/baseline.<label>.json) and the PERF.md
// section heading, so multiple baselines can coexist without overwriting
// each other. Set via env, never hard-coded, so switching targets doesn't
// require editing this file.
const BASELINE_LABEL = process.env.BASELINE_LABEL || 'dev-server';

if (!GRAPHQL_ENDPOINT || !ADMIN_SECRET) {
  throw new Error(`Missing VITE_GRAPHQL_ENDPOINT / VITE_HASURA_ADMIN_SECRET in ${path.join(CONSOLE_DIR, '.env')}`);
}

// ---------------------------------------------------------------------------
// Preflight: talk to Hasura directly (admin secret, server-side only in this
// script — never sent from the browser) to find real seeded fixtures to
// drive the scenarios with, and to record actual row counts for the report.
// ---------------------------------------------------------------------------
async function gql(query, variables = {}) {
  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hasura-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  return json.data;
}

async function preflight() {
  const counts = await gql(`
    query Counts {
      invocations_aggregate { aggregate { count } }
      event_executions_aggregate { aggregate { count } }
      job_executions_aggregate { aggregate { count } }
    }
  `);

  const anyInvocation = await gql(`query { invocations(limit: 1) { correlation_id } }`);
  const sampleCorrelationId = anyInvocation.invocations[0]?.correlation_id;

  // Find the correlation_id with the most chained children, so the flow page
  // renders a real multi-invocation tree (>=5 nodes once event/job sub-nodes
  // are counted), then take that group's root invocation id.
  const children = await gql(`
    query {
      invocations(where: { source_job_id: { _is_null: false } }, limit: 3000) {
        correlation_id
      }
    }
  `);
  const countByCorrelation = new Map();
  for (const { correlation_id } of children.invocations) {
    countByCorrelation.set(correlation_id, (countByCorrelation.get(correlation_id) || 0) + 1);
  }
  let busiestCorrelationId = null;
  let busiestCount = 0;
  for (const [cid, count] of countByCorrelation) {
    if (count > busiestCount) {
      busiestCount = count;
      busiestCorrelationId = cid;
    }
  }

  let chainedInvocationId = null;
  if (busiestCorrelationId) {
    const rootResult = await gql(
      `query($cid: String) {
        invocations(where: { correlation_id: { _eq: $cid }, source_job_id: { _is_null: true } }, limit: 1) {
          id
        }
      }`,
      { cid: busiestCorrelationId }
    );
    chainedInvocationId = rootResult.invocations[0]?.id;
  }

  return {
    counts: {
      invocations: counts.invocations_aggregate.aggregate.count,
      event_executions: counts.event_executions_aggregate.aggregate.count,
      job_executions: counts.job_executions_aggregate.aggregate.count,
    },
    sampleCorrelationId,
    chainedInvocationId,
    chainedInvocationChildCount: busiestCount,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Sets a React-controlled input's value via the native setter so React's onChange actually fires (a plain `.value =` assignment is invisible to React's synthetic event system) — used to simulate a paste. */
async function setReactInputValue(page, selector, text) {
  await page.evaluate(
    (sel, value) => {
      const input = document.querySelector(sel);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    selector,
    text
  );
}

const SEARCH_INPUT_SELECTOR = 'input[placeholder^="Search by correlation ID"]';

// Under this throttle profile, a fresh page load of the (unbundled, dev-mode,
// no-code-splitting — see plan finding P9) Vite dev server consistently takes
// ~65-70s on its own, before any GraphQL query even fires — confirmed by
// early runs where every scenario's setup navigation needed close to that
// long regardless of route. That's a real cost, just a different one than
// the query-level slowness these scenarios target, so navigation/content-wait
// timeouts are generous here to let scenarios complete rather than
// mask/truncate that cost by timing out. See PERF.md for the caveat this
// implies for reading the cold-load-* numbers.
const PAGE_LOAD_TIMEOUT_MS = 150000;

/** Attaches CDP throttling + a GraphQL network log to a fresh page. Returns { page, client, gqlLog } where gqlLog is an array of {requestId, startTs, endTs, bytes} mutated in place as requests complete. */
async function newThrottledPage(browser) {
  const page = await browser.newPage();
  await page.setCacheEnabled(false); // cold-load scenarios must not hit HTTP cache
  await page.setViewport({ width: 1440, height: 900 });

  const client = await page.createCDPSession();
  await client.send('Network.enable');
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 40, // ms RTT
    downloadThroughput: (1.6 * 1000 * 1000) / 8, // 1.6 Mbps -> bytes/sec
    uploadThroughput: (0.75 * 1000 * 1000) / 8, // 0.75 Mbps -> bytes/sec
  });

  const gqlLog = [];
  const byRequestId = new Map();
  client.on('Network.requestWillBeSent', event => {
    if (!event.request.url.includes('/v1/graphql')) return;
    const entry = { requestId: event.requestId, startTs: performance.now(), endTs: null, bytes: 0 };
    byRequestId.set(event.requestId, entry);
    gqlLog.push(entry);
  });
  client.on('Network.loadingFinished', event => {
    const entry = byRequestId.get(event.requestId);
    if (entry) {
      entry.endTs = performance.now();
      entry.bytes = event.encodedDataLength;
    }
  });

  return { page, client, gqlLog };
}

/** Waits until no GraphQL request has completed for `idleMs`, or `timeoutMs` elapses. */
async function waitForGraphQLIdle(gqlLog, { idleMs = 500, timeoutMs = 15000, sinceIndex = 0 } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const relevant = gqlLog.slice(sinceIndex);
    const lastActivity = relevant.reduce((max, e) => Math.max(max, e.endTs ?? e.startTs), 0);
    const now = performance.now();
    const allSettled = relevant.every(e => e.endTs !== null);
    if (allSettled && (relevant.length === 0 || now - lastActivity >= idleMs)) return;
    if (now > deadline) return; // best-effort: report what we have rather than hang
    await sleep(50);
  }
}

function countAndSumSince(gqlLog, sinceIndex) {
  const relevant = gqlLog.slice(sinceIndex);
  return { count: relevant.length, bytes: relevant.reduce((sum, e) => sum + (e.bytes || 0), 0) };
}

// ---------------------------------------------------------------------------
// Scenarios — each returns { ms, gqlCount, bytes, note? } for one run.
// ---------------------------------------------------------------------------
const scenarios = {
  async 'cold-load-overview'(browser) {
    const { page, gqlLog } = await newThrottledPage(browser);
    try {
      const t0 = performance.now();
      await page.goto(`${APP_URL}/`, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
      await page.waitForFunction(
        () => {
          const els = document.querySelectorAll('p.text-3xl');
          if (els.length < 4) return false;
          return Array.from(els).some(el => {
            const t = el.textContent.trim();
            return t !== '' && !/^0(\.0+)?%?$/.test(t);
          });
        },
        { timeout: PAGE_LOAD_TIMEOUT_MS }
      );
      const ms = performance.now() - t0;
      const { count, bytes } = countAndSumSince(gqlLog, 0);
      return { ms, gqlCount: count, bytes };
    } finally {
      await page.close();
    }
  },

  async 'cold-load-invocations'(browser) {
    const { page, gqlLog } = await newThrottledPage(browser);
    try {
      const t0 = performance.now();
      await page.goto(`${APP_URL}/invocations`, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
      await page.waitForFunction(() => document.querySelectorAll('[data-inv-table] tbody tr').length >= 10, {
        timeout: PAGE_LOAD_TIMEOUT_MS,
      });
      const ms = performance.now() - t0;
      const { count, bytes } = countAndSumSince(gqlLog, 0);
      return { ms, gqlCount: count, bytes };
    } finally {
      await page.close();
    }
  },

  async 'search-keystrokes'(browser, ctx) {
    const { page, gqlLog } = await newThrottledPage(browser);
    try {
      await page.goto(`${APP_URL}/invocations`, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
      await page.waitForSelector(SEARCH_INPUT_SELECTOR, { timeout: 15000 });
      await page.click(SEARCH_INPUT_SELECTOR);

      const sinceIndex = gqlLog.length;
      await page.type(SEARCH_INPUT_SELECTOR, 'move.pickup', { delay: 50 });
      const lastKeystrokeTs = performance.now();

      await waitForGraphQLIdle(gqlLog, { idleMs: 500, timeoutMs: 15000, sinceIndex });
      const ms = performance.now() - lastKeystrokeTs;
      const { count, bytes } = countAndSumSince(gqlLog, sinceIndex);
      return { ms, gqlCount: count, bytes, note: 'gqlCount = requests fired during typing (debounce metric)' };
    } finally {
      await page.close();
    }
  },

  async 'search-correlation'(browser, ctx) {
    const { page, gqlLog } = await newThrottledPage(browser);
    try {
      await page.goto(`${APP_URL}/invocations`, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
      await page.waitForSelector(SEARCH_INPUT_SELECTOR, { timeout: 15000 });
      await page.click(SEARCH_INPUT_SELECTOR);

      const sinceIndex = gqlLog.length;
      const t0 = performance.now();
      await setReactInputValue(page, SEARCH_INPUT_SELECTOR, ctx.sampleCorrelationId);
      await waitForGraphQLIdle(gqlLog, { idleMs: 400, timeoutMs: 15000, sinceIndex });
      const ms = performance.now() - t0;
      const { count, bytes } = countAndSumSince(gqlLog, sinceIndex);
      return { ms, gqlCount: count, bytes };
    } finally {
      await page.close();
    }
  },

  async 'facet-status-failed'(browser) {
    const { page } = await newThrottledPage(browser);
    try {
      await page.goto(`${APP_URL}/invocations`, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
      await page.waitForFunction(() => document.querySelectorAll('[data-inv-table] tbody tr').length >= 10, {
        timeout: 60000,
      });

      const statusSelectHandle = await page.evaluateHandle(() =>
        Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.value === 'failed'))
      );
      const el = statusSelectHandle.asElement();
      if (!el) throw new Error('status filter <select> not found — page markup may have changed');

      const before = await page.evaluate(() => document.querySelector('h2')?.parentElement?.querySelector('p')?.textContent || '');
      const t0 = performance.now();
      await el.select('failed');
      await page.waitForFunction(
        prevText => {
          const summary = document.querySelector('h2')?.parentElement?.querySelector('p');
          return summary && summary.textContent !== prevText;
        },
        { timeout: 10000 },
        before
      );
      const ms = performance.now() - t0;
      return { ms, gqlCount: 0, bytes: 0, note: 'client-side filter over the already-fetched page (P1/U3 — no server round trip today)' };
    } finally {
      await page.close();
    }
  },

  async 'paginate'(browser) {
    const { page } = await newThrottledPage(browser);
    try {
      await page.goto(`${APP_URL}/invocations`, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
      await page.waitForFunction(() => document.querySelectorAll('[data-inv-table] tbody tr').length >= 10, {
        timeout: 60000,
      });
      const nextButton = await page.evaluateHandle(() =>
        Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Next')
      );
      const el = nextButton.asElement();
      if (!el) throw new Error('pagination "Next" button not found');

      const firstRowBefore = await page.$eval('[data-inv-table] tbody tr', tr => tr.textContent);
      const t0 = performance.now();
      await el.click();
      await page.waitForFunction(
        prevText => document.querySelector('[data-inv-table] tbody tr')?.textContent !== prevText,
        { timeout: 10000 },
        firstRowBefore
      );
      const ms = performance.now() - t0;
      return { ms, gqlCount: 0, bytes: 0, note: 'client-side pagination over the already-fetched page' };
    } finally {
      await page.close();
    }
  },

  async 'drawer-open'(browser) {
    const { page } = await newThrottledPage(browser);
    try {
      await page.goto(`${APP_URL}/invocations`, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
      await page.waitForFunction(() => document.querySelectorAll('[data-inv-table] tbody tr').length >= 10, {
        timeout: 60000,
      });
      const quickDetailsButton = await page.evaluateHandle(() =>
        document.querySelector('[data-inv-table] tbody tr')?.querySelector('button[title="Quick Details"]')
      );
      const el = quickDetailsButton.asElement();
      if (!el) throw new Error('Quick Details button not found on first row');

      const t0 = performance.now();
      await el.click();
      // InvocationDetailDrawer renders a fixed right-side panel with a
      // `w-[600px]` Tailwind arbitrary-value class — distinctive enough to
      // wait on without a test-id in the markup.
      await page.waitForSelector('[class*="w-[600px]"]', { timeout: 10000 });
      const ms = performance.now() - t0;
      return { ms, gqlCount: 0, bytes: 0 };
    } finally {
      await page.close();
    }
  },

  async 'flow-render'(browser, ctx) {
    if (!ctx.chainedInvocationId) {
      return { ms: null, gqlCount: null, bytes: null, note: 'SKIPPED: no chained invocation id found in seeded data' };
    }
    const { page, gqlLog } = await newThrottledPage(browser);
    try {
      const t0 = performance.now();
      await page.goto(`${APP_URL}/flow?invocationId=${ctx.chainedInvocationId}`, {
        waitUntil: 'domcontentloaded',
        timeout: PAGE_LOAD_TIMEOUT_MS,
      });
      await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length >= 5, {
        timeout: PAGE_LOAD_TIMEOUT_MS,
      });
      const ms = performance.now() - t0;
      const { count, bytes } = countAndSumSince(gqlLog, 0);
      return { ms, gqlCount: count, bytes };
    } finally {
      await page.close();
    }
  },

  async 'hidden-tab-poll'(browser) {
    const { page, gqlLog } = await newThrottledPage(browser);
    try {
      await page.goto(`${APP_URL}/`, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('p.text-3xl')).some(el => el.textContent.trim() !== ''),
        { timeout: 30000 }
      );

      // Override document.hidden/visibilityState directly (rather than CDP
      // Page.setWebLifecycleState('frozen'), which halts ALL page JS
      // including timers — that would trivially report "0 requests" without
      // testing whether the app's own polling logic respects visibility).
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });

      const sinceIndex = gqlLog.length;
      await sleep(30000);
      const { count, bytes } = countAndSumSince(gqlLog, sinceIndex);
      return { ms: 30000, gqlCount: count, bytes, note: 'gqlCount = GraphQL requests fired during a 30s emulated-hidden window (target: 0)' };
    } finally {
      await page.close();
    }
  },
};

const SCENARIO_ORDER = [
  'cold-load-overview',
  'cold-load-invocations',
  'search-keystrokes',
  'search-correlation',
  'facet-status-failed',
  'paginate',
  'drawer-open',
  'flow-render',
  'hidden-tab-poll',
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function runScenario(browser, name, ctx, runs = 3) {
  const fn = scenarios[name];
  const results = [];
  for (let i = 0; i < runs; i++) {
    log(`  ${name} — run ${i + 1}/${runs}...`);
    try {
      const result = await fn(browser, ctx);
      results.push(result);
      log(`    ms=${result.ms === null ? 'n/a' : Math.round(result.ms)} gql=${result.gqlCount ?? 'n/a'} bytes=${result.bytes ?? 'n/a'}`);
    } catch (err) {
      log(`    FAILED: ${err.message}`);
      results.push({ ms: null, gqlCount: null, bytes: null, error: err.message });
    }
  }

  const okResults = results.filter(r => r.ms !== null && !r.error);
  const medianMs = okResults.length ? median(okResults.map(r => r.ms)) : null;
  const medianGqlCount = okResults.length ? median(okResults.map(r => r.gqlCount)) : null;
  const medianBytes = okResults.length ? median(okResults.map(r => r.bytes)) : null;
  const note = results.find(r => r.note)?.note;
  const errors = results.filter(r => r.error).map(r => r.error);

  return { name, runs: results, medianMs, medianGqlCount, medianBytes, note, errors: errors.length ? errors : undefined };
}

async function main() {
  log(`App URL: ${APP_URL}`);
  log(`Baseline label: ${BASELINE_LABEL}`);
  log('Running preflight queries against Hasura...');
  const ctx = await preflight();
  log(`  counts: ${JSON.stringify(ctx.counts)}`);
  log(`  sampleCorrelationId: ${ctx.sampleCorrelationId}`);
  log(`  chainedInvocationId: ${ctx.chainedInvocationId} (${ctx.chainedInvocationChildCount} children in its correlation group)`);

  if (!ctx.sampleCorrelationId) throw new Error('No seeded invocations found — run the seeder first (npm run seed -- --invocations 200000)');

  const browser = await puppeteer.launch({ headless: true });
  const results = [];
  try {
    for (const name of SCENARIO_ORDER) {
      log(`Scenario: ${name}`);
      results.push(await runScenario(browser, name, ctx));
    }
  } finally {
    await browser.close();
  }

  let gitSha = 'unknown';
  try {
    gitSha = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    // not fatal — repo may be detached/unavailable in some environments
  }

  const baseline = {
    date: new Date().toISOString(),
    gitSha,
    appUrl: APP_URL,
    seedCounts: ctx.counts,
    throttle: {
      cpu: '4x slowdown',
      network: 'latency=40ms, download=1.6Mbps, upload=0.75Mbps (Fast-3G-ish)',
    },
    scenarios: results,
  };

  fs.writeFileSync(path.join(__dirname, 'baseline.json'), JSON.stringify(baseline, null, 2) + '\n');
  log('Wrote perf/baseline.json');

  appendPerfMd(baseline);
  log('Appended perf/../PERF.md');
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return 'n/a';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined) return 'n/a';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function appendPerfMd(baseline) {
  const perfMdPath = path.join(CONSOLE_DIR, 'PERF.md');
  const existing = fs.existsSync(perfMdPath) ? fs.readFileSync(perfMdPath, 'utf8') : '# EventKit Console — Perf Log\n\nBaseline and before/after measurements from `perf/measure.mjs`, per docs/planning/console-migration-plan.md §8.\n';

  const lines = [];
  lines.push('');
  lines.push(`## ${baseline.date}`);
  lines.push('');
  lines.push(`- git sha: \`${baseline.gitSha}\``);
  lines.push(`- seed: ${baseline.seedCounts.invocations.toLocaleString()} invocations / ${baseline.seedCounts.event_executions.toLocaleString()} event_executions / ${baseline.seedCounts.job_executions.toLocaleString()} job_executions`);
  lines.push(`- throttle: CPU ${baseline.throttle.cpu}; network ${baseline.throttle.network}`);
  lines.push('');
  lines.push('| Scenario | Median | GraphQL requests | Bytes | Notes |');
  lines.push('|---|---|---|---|---|');
  for (const s of baseline.scenarios) {
    const note = [s.note, s.errors ? `errors: ${s.errors.join('; ')}` : null].filter(Boolean).join(' — ');
    lines.push(`| ${s.name} | ${fmtMs(s.medianMs)} | ${s.medianGqlCount ?? 'n/a'} | ${fmtBytes(s.medianBytes)} | ${note} |`);
  }
  lines.push('');

  fs.writeFileSync(perfMdPath, existing + lines.join('\n'));
}

main().catch(err => {
  console.error('[perf] FAILED:', err);
  process.exit(1);
});
