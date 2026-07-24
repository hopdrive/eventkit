import { describe, it, expect } from 'vitest';
import { encodeOriginId, decodeOriginId, isOriginId, ORIGIN_ID_MAGIC, ORIGIN_ID_VERSION } from '../origin-id.js';

const MAGIC_HEX = 'c0ffee';

describe('origin-id codec', () => {
  it('exposes the magic and version constants', () => {
    expect(ORIGIN_ID_MAGIC).toBe(0xc0ffee);
    expect(ORIGIN_ID_VERSION).toBe(1);
  });

  it('encodes a 32-char lowercase hex id with the magic, version, origin and env in place', () => {
    const id = encodeOriginId({ originId: 42, env: 1 });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).toHaveLength(32);
    expect(id.slice(0, 6)).toBe(MAGIC_HEX);
    expect(id.slice(6, 7)).toBe('1'); // version nibble
    expect(id.slice(7, 9)).toBe('2a'); // originId 42
    expect(id.slice(9, 11)).toBe('01'); // flags byte: env=1, reserved zero
  });

  it('round trips every named env value', () => {
    const cases: Array<[number, string]> = [
      [0, 'unknown'],
      [1, 'prod'],
      [2, 'test'],
      [3, 'preview'],
      [4, 'local'],
    ];
    for (const [env, envName] of cases) {
      const decoded = decodeOriginId(encodeOriginId({ originId: 7, env }));
      expect(decoded).not.toBeNull();
      expect(decoded).toMatchObject({ version: 1, originId: 7, env, envName });
    }
  });

  it('round trips reserved env values 5-7 with envName "unknown"', () => {
    for (const env of [5, 6, 7]) {
      const decoded = decodeOriginId(encodeOriginId({ originId: 0, env }));
      expect(decoded).toMatchObject({ env, envName: 'unknown' });
    }
  });

  it('round trips originId boundaries 0 and 255', () => {
    for (const originId of [0, 255]) {
      const decoded = decodeOriginId(encodeOriginId({ originId, env: 2 }));
      expect(decoded).toMatchObject({ originId });
    }
  });

  it('exposes the raw flags byte on decode', () => {
    const decoded = decodeOriginId(encodeOriginId({ originId: 1, env: 3 }));
    expect(decoded?.flags).toBe(3); // env=3 in the low bits, reserved zero
  });

  it('throws on an out-of-range originId', () => {
    expect(() => encodeOriginId({ originId: -1, env: 1 })).toThrow();
    expect(() => encodeOriginId({ originId: 256, env: 1 })).toThrow();
    expect(() => encodeOriginId({ originId: 1.5, env: 1 })).toThrow();
  });

  it('throws on an out-of-range env', () => {
    expect(() => encodeOriginId({ originId: 1, env: -1 })).toThrow();
    expect(() => encodeOriginId({ originId: 1, env: 8 })).toThrow();
  });

  it('decode rejects a wrong-length string', () => {
    expect(decodeOriginId(MAGIC_HEX)).toBeNull();
    expect(decodeOriginId(`${MAGIC_HEX}1002` + '0'.repeat(30))).toBeNull();
  });

  it('decode rejects uppercase hex', () => {
    const id = encodeOriginId({ originId: 10, env: 1 });
    expect(decodeOriginId(id.toUpperCase())).toBeNull();
    expect(isOriginId(id.toUpperCase())).toBe(false);
  });

  it('decode rejects a non-hex string of the right length', () => {
    expect(decodeOriginId('z'.repeat(32))).toBeNull();
  });

  it('decode rejects a 32-hex id with the wrong magic', () => {
    const id = encodeOriginId({ originId: 10, env: 1 });
    const wrongMagic = 'deadbe' + id.slice(6);
    expect(decodeOriginId(wrongMagic)).toBeNull();
    expect(isOriginId(wrongMagic)).toBe(false);
  });

  it('decode returns null for an unknown (future) version', () => {
    const id = encodeOriginId({ originId: 10, env: 1 });
    const v2 = `${MAGIC_HEX}2${id.slice(7)}`; // version nibble bumped to 2
    expect(decodeOriginId(v2)).toBeNull();
    const v0 = `${MAGIC_HEX}0${id.slice(7)}`; // version nibble 0
    expect(decodeOriginId(v0)).toBeNull();
  });

  it('tolerates nonzero reserved flag bits on decode (forward compat)', () => {
    const id = encodeOriginId({ originId: 5, env: 2 });
    // Set the whole flags byte to 0xfa: env = 0xfa & 0x07 = 2, reserved bits set.
    const withReserved = `${id.slice(0, 9)}fa${id.slice(11)}`;
    const decoded = decodeOriginId(withReserved);
    expect(decoded).not.toBeNull();
    expect(decoded).toMatchObject({ env: 2, envName: 'test', flags: 0xfa });
  });

  it('isOriginId is a cheap magic + shape check', () => {
    expect(isOriginId(encodeOriginId({ originId: 1, env: 1 }))).toBe(true);
    expect(isOriginId('abcdef0123456789abcdef0123456789')).toBe(false); // 32 hex, wrong magic
    expect(isOriginId('c0ffee')).toBe(false); // right magic, wrong length
  });

  it('two encodes with the same inputs do not collide (random bits differ)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const id = encodeOriginId({ originId: 1, env: 1 });
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});
