// =============================================================================
// Property tests: plugin-surface invariants (testing-strategy.md §20, P2)
// =============================================================================
// Three surfaces that take adversarial/untrusted input and must not misbehave:
//   1. the loop-guard token codec (parses vendor-echoed strings),
//   2. the ADR-033 augmentEnvelope meta deep-merge (order-independent),
//   3. hasura normalize (runs on whatever a trigger/console delivers).
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createEventKit, job, type EventKitPlugin, type JobContext } from '../../index.js';
import { fakeSource, defineFakeEvent, buildDetectorContextFor } from '../../testing/index.js';
import { createTokenCodec } from '../loop-guard/index.js';
import { hasuraEvent } from '../source-hasura.js';

const SEPARATORS = ['.', '|', ':', '#'] as const;
const sanitize = (v: string, sep: string): string => v.split(sep).join('_');

describe('property: loop-guard token codec round-trips and never throws', () => {
  it('create → parse recovers source (sanitized), correlationId, and jobId (sanitized)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SEPARATORS),
        fc.string({ minLength: 1 }), // source may embed the separator → sanitized away
        fc.uuid(), // correlation id is separator-free by construction
        fc.string({ minLength: 1 }), // job id may embed the separator → sanitized away
        (sep, source, corr, jobId) => {
          const codec = createTokenCodec({ separator: sep });
          const parsed = codec.parse(codec.create(source, corr, jobId));
          expect(parsed).not.toBeNull();
          expect(parsed!.source).toBe(sanitize(source, sep));
          expect(parsed!.correlationId).toBe(corr);
          expect(parsed!.jobExecutionId).toBe(sanitize(jobId, sep));
        },
      ),
    );
  });

  it('parse / isValid tolerate arbitrary hostile strings (return null/boolean, never throw)', () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom(...SEPARATORS), fc.boolean(), (s, sep, validateCorrelationId) => {
        const codec = createTokenCodec({ separator: sep, validateCorrelationId });
        expect(() => codec.parse(s)).not.toThrow();
        expect(typeof codec.isValid(s)).toBe('boolean');
        // a value that isValid rejects must parse to null (the two agree)
        if (!codec.isValid(s)) expect(codec.parse(s)).toBeNull();
      }),
    );
  });
});

describe('property: augmentEnvelope meta deep-merge is order-independent (ADR-033)', () => {
  it("preserves every plugin's meta key regardless of registration order", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(fc.integer({ min: 0, max: 12 }), { minLength: 1, maxLength: 8 }), async ids => {
        let captured: Record<string, unknown> = {};
        const mod = defineFakeEvent('e', () => true, [job((c: JobContext) => void (captured = c.envelope.meta as Record<string, unknown>))]);
        let kit = createEventKit(fakeSource());
        // Each plugin contributes exactly one distinct meta key, in the (arbitrary) array order.
        ids.forEach((id, i) => {
          const plugin: EventKitPlugin = { name: `p-${i}`, augmentEnvelope: () => ({ meta: { [`m${id}`]: id } }) };
          kit = kit.use(plugin);
        });
        kit.registerEvents([mod]);
        await kit.handle('go');
        for (const id of ids) expect(captured[`m${id}`]).toBe(id); // none clobbered by a sibling merge
      }),
    );
  });
});

describe('property: hasura normalize never throws uncontrolled on malformed payloads', () => {
  it('rejects garbage only with a controlled Error (never a raw crash)', () => {
    fc.assert(
      fc.property(fc.anything(), raw => {
        let threw: unknown;
        try {
          buildDetectorContextFor(hasuraEvent, raw);
        } catch (e) {
          threw = e;
        }
        if (threw !== undefined) expect(threw).toBeInstanceOf(Error);
      }),
    );
  });
});
