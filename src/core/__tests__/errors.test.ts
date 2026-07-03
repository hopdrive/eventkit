// =============================================================================
// LoopDetectedError brand + serialization (ADR-041)
// =============================================================================
// LoopDetectedError is brand-checked exactly like ClientError (a registry Symbol
// survives bundled module copies) and rides its detail on `.data` so the existing
// serializeError carries it into SerializedError.data with zero extra wiring.

import { describe, it, expect } from 'vitest';
import { LoopDetectedError, isLoopDetectedError, serializeError } from '../../index.js';

const detail = {
  correlationId: 'corr-1',
  depth: 3,
  ceiling: 3,
  serviceId: 'svc-a',
  sourceFunction: 'db-moves',
};

describe('LoopDetectedError', () => {
  it('carries the detail on readonly fields and on .data', () => {
    const err = new LoopDetectedError('halted', detail);
    expect(err.name).toBe('LoopDetectedError');
    expect(err.correlationId).toBe('corr-1');
    expect(err.depth).toBe(3);
    expect(err.ceiling).toBe(3);
    expect(err.serviceId).toBe('svc-a');
    expect(err.sourceFunction).toBe('db-moves');
    expect(err.data).toEqual(detail);
  });

  it('is recognized by the brand check', () => {
    expect(isLoopDetectedError(new LoopDetectedError('halted', detail))).toBe(true);
  });

  it('rejects a look-alike that only sets name', () => {
    expect(isLoopDetectedError({ name: 'LoopDetectedError', data: detail })).toBe(false);
    expect(isLoopDetectedError(new Error('halted'))).toBe(false);
    expect(isLoopDetectedError(null)).toBe(false);
    expect(isLoopDetectedError('LoopDetectedError')).toBe(false);
  });

  it('serializeError round-trips the detail through .data', () => {
    const ser = serializeError(new LoopDetectedError('halted', detail));
    expect(ser.name).toBe('LoopDetectedError');
    expect(ser.message).toBe('halted');
    expect(ser.data).toEqual(detail);
  });

  it('omits sourceFunction when absent', () => {
    const { sourceFunction: _drop, ...noFn } = detail;
    const err = new LoopDetectedError('halted', noFn);
    expect(err.sourceFunction).toBeUndefined();
    expect(err.data).toEqual(noFn);
    expect(serializeError(err).data).toEqual(noFn);
  });
});
