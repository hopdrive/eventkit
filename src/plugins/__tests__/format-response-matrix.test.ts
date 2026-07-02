// =============================================================================
// formatResponse matrix (testing-strategy.md §1 P0-D)
// =============================================================================
// { resolved output, ClientError, ActionError, framework error, timeout }
//   × { netlify, netlify-v2, netlify-background, lambda }
// formatResponse is what a vendor's retry contract actually sees, so every cell is
// a promise to an external caller. Locks: only a framework error is a 500 (the one
// retryable path); a resolve throw is its ClientError status (or 400 for an
// ActionError); a resolved output is 200; a fire-and-forget timeout is NOT a 500
// (no vendor retry) — you opt into that with `respond`. Background always defers (202).
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  netlifyPlatform, lambdaPlatform, netlifyV2Platform, netlifyBackgroundPlatform,
} from '../platforms.js';
import type { InvocationResult } from '../../index.js';

const res = (partial: Partial<InvocationResult>): InvocationResult => ({
  ok: true,
  invocationId: 'inv-1' as InvocationResult['invocationId'],
  events: [],
  durationMs: 1,
  ...partial,
});

const OUTCOMES = {
  'resolved-output': {
    result: res({ ok: true, resolved: { hasResolved: true, output: { hello: 'world' } } }),
    status: 200, bodyIncludes: ['hello', 'world'],
  },
  'ClientError (status contract)': {
    result: res({ ok: true, resolved: { hasResolved: true, error: { message: 'nope', status: 422 } } }),
    status: 422, bodyIncludes: ['nope'],
  },
  'ActionError (graphql code)': {
    result: res({ ok: true, resolved: { hasResolved: true, error: { message: 'bad', code: 'BAD_INPUT', extensions: { code: 'BAD_INPUT' } } } }),
    status: 400, bodyIncludes: ['bad', 'BAD_INPUT'],
  },
  'framework error (retryable)': {
    result: res({ ok: false, error: { name: 'Error', message: 'boom' } }),
    status: 500, bodyIncludes: ['boom'],
  },
  'fire-and-forget timeout (NOT a 500)': {
    result: res({ ok: false, timedOut: true, events: [{ name: 'e', detected: true, jobs: [] }] }),
    status: 200, bodyIncludes: [],
  },
} as const;

const httpRead = (r: unknown) => {
  const x = r as { statusCode: number; body?: string };
  return { status: x.statusCode, body: x.body };
};
const responseRead = async (r: unknown) => {
  const x = r as Response;
  return { status: x.status, body: await x.text() };
};

const PLATFORMS = [
  { name: 'netlify', make: () => netlifyPlatform(), read: (r: unknown) => Promise.resolve(httpRead(r)) },
  { name: 'lambda', make: () => lambdaPlatform(), read: (r: unknown) => Promise.resolve(httpRead(r)) },
  { name: 'netlify-v2', make: () => netlifyV2Platform(), read: responseRead },
  { name: 'netlify-background', make: () => netlifyBackgroundPlatform(), read: (r: unknown) => Promise.resolve(httpRead(r)), background: true },
];

describe('formatResponse matrix (outcome × platform)', () => {
  for (const plat of PLATFORMS) {
    for (const [outcomeName, oc] of Object.entries(OUTCOMES)) {
      it(`${plat.name} · ${outcomeName}`, async () => {
        const adapter = plat.make();
        const formatted = adapter.formatResponse!(oc.result);
        const { status, body } = await plat.read(formatted);

        if (plat.background) {
          // Background defers: 202 regardless of outcome (deferredResponse — the reply is gone).
          expect(status).toBe(202);
          return;
        }
        expect(status).toBe(oc.status);
        for (const frag of oc.bodyIncludes) expect(body ?? '').toContain(frag);
      });
    }
  }
});
