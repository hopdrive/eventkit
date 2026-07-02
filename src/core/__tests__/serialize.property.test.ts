// =============================================================================
// Property tests: error/output serialization is total (testing-strategy.md §20, P2)
// =============================================================================
// serializeError / replaceCircularReferences sit on the observability + error
// paths — they run on WHATEVER a job or plugin throws or returns. So their one
// non-negotiable contract is totality: for ANY input (cycles, bigint, functions,
// symbols, nested Errors) they must produce JSON-serializable output and never
// throw. fast-check fuzzes that surface far past what example tests reach.
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { serializeError, replaceCircularReferences } from '../../index.js';

// A value space that deliberately includes the types plain JSON.stringify chokes on.
const hostileValue = () =>
  fc.oneof(
    fc.anything(),
    fc.bigInt(),
    fc.func(fc.anything()),
    fc.constant(Symbol('s')),
    fc.date(),
    fc.constant(undefined),
  );

describe('property: replaceCircularReferences is total and JSON-safe', () => {
  it('never throws and yields JSON-serializable output for arbitrary values', () => {
    fc.assert(
      fc.property(hostileValue(), v => {
        const out = replaceCircularReferences(v);
        const json = JSON.stringify(out); // must not throw (bigint/fn/symbol already replaced)
        expect(json === undefined || typeof json === 'string').toBe(true);
      }),
    );
  });

  it('replaces a self-referential cycle with [Circular] instead of throwing', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.anything()), base => {
        const obj: Record<string, unknown> = { ...base };
        obj['self'] = obj; // inject a cycle at a fresh key
        const out = replaceCircularReferences(obj) as Record<string, unknown>;
        expect(out['self']).toBe('[Circular]');
        expect(() => JSON.stringify(out)).not.toThrow();
      }),
    );
  });

  it('handles a cycle nested inside arrays and deeper objects', () => {
    const root: Record<string, unknown> = { a: [1, 2] };
    const child: Record<string, unknown> = { parent: root };
    (root['a'] as unknown[]).push(child);
    root['child'] = child;
    const out = replaceCircularReferences(root);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

describe('property: serializeError is total', () => {
  it('always returns an object with a string message and JSON-safe fields', () => {
    fc.assert(
      fc.property(hostileValue(), v => {
        const out = serializeError(v);
        expect(typeof out.name).toBe('string');
        expect(typeof out.message).toBe('string');
        expect(() => JSON.stringify(out)).not.toThrow();
      }),
    );
  });

  it('serializes a real Error with a circular `data` payload without throwing', () => {
    fc.assert(
      fc.property(fc.string(), fc.dictionary(fc.string(), fc.anything()), (msg, data) => {
        const err = new Error(msg) as Error & { data: Record<string, unknown> };
        err.data = { ...data };
        err.data['loop'] = err.data; // cyclic data
        const out = serializeError(err);
        expect(out.message).toBe(msg || '');
        expect(() => JSON.stringify(out)).not.toThrow();
      }),
    );
  });
});
