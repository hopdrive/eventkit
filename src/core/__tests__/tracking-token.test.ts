import { describe, it, expect } from 'vitest';
import { createTokenCodec, isCorrelationIdShape } from '../tracking-token.js';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const HEX32 = 'abcdef0123456789abcdef0123456789'; // 32 hex, dashless (Hasura trace id shape)

describe('isCorrelationIdShape (ADR-040)', () => {
  it('accepts canonical UUID and 32-hex dashless', () => {
    expect(isCorrelationIdShape(UUID)).toBe(true);
    expect(isCorrelationIdShape(HEX32)).toBe(true);
    expect(isCorrelationIdShape(UUID.toUpperCase())).toBe(true);
  });

  it('rejects garbage and near-misses', () => {
    expect(isCorrelationIdShape('not-an-id')).toBe(false);
    expect(isCorrelationIdShape('abcdef0123456789abcdef012345678')).toBe(false); // 31 hex
    expect(isCorrelationIdShape('abcdef0123456789abcdef01234567890')).toBe(false); // 33 hex
    expect(isCorrelationIdShape('123e4567e89b-12d3-a456-426614174000')).toBe(false); // wrong grouping
    expect(isCorrelationIdShape('')).toBe(false);
    expect(isCorrelationIdShape('ghijkl0123456789abcdef0123456789')).toBe(false); // non-hex
  });

  it('rejects non-string inputs', () => {
    expect(isCorrelationIdShape(undefined)).toBe(false);
    expect(isCorrelationIdShape(null)).toBe(false);
    expect(isCorrelationIdShape(123)).toBe(false);
    expect(isCorrelationIdShape({})).toBe(false);
  });
});

describe('createTokenCodec with validateCorrelationId (ADR-040)', () => {
  const codec = createTokenCodec({ separator: '|', validateCorrelationId: true });

  it('accepts a canonical UUID correlation id', () => {
    expect(codec.isValid(`svc|${UUID}|job-1`)).toBe(true);
  });

  it('accepts a 32-hex dashless correlation id (Hasura trace root)', () => {
    expect(codec.isValid(`svc|${HEX32}|job-1`)).toBe(true);
  });

  it('rejects garbage correlation ids', () => {
    expect(codec.isValid('svc|not-an-id|job-1')).toBe(false);
    expect(codec.isValid('svc|abcdef0123456789abcdef012345678|job-1')).toBe(false); // 31 hex
    expect(codec.isValid('svc|abcdef0123456789abcdef01234567890|job-1')).toBe(false); // 33 hex
    expect(codec.isValid('svc|123e4567e89b-12d3-a456-426614174000|job-1')).toBe(false); // wrong grouping
    expect(codec.isValid(`svc||job-1`)).toBe(false); // empty part
  });

  it('round-trips create → parse recovering all four components', () => {
    const token = codec.create('svc', HEX32, 'job-1', 2);
    const parsed = codec.parse(token);
    expect(parsed).toEqual({ source: 'svc', correlationId: HEX32, jobExecutionId: 'job-1', hopDepth: 2 });
  });
});
