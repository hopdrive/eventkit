import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findEventNameMismatches, assertEventNamesMatchFilenames } from '../index.js';

describe('assertEventNamesMatchFilenames', () => {
  it('the shipped example module name matches its filename', () => {
    // src/__examples__/appointment.ready.ts → defineEvent({ name: 'appointment.ready' })
    expect(findEventNameMismatches({ dir: 'src/__examples__' })).toEqual([]);
  });

  it('flags a name ≠ filename, passes a match, and skips non-event files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ek-eventnames-'));
    try {
      // matches its stem (after stripping .eventkit) → OK
      writeFileSync(join(dir, 'order.created.eventkit.js'), `module.exports = defineEvent({ name: 'order.created', detector: () => true, jobs: [] });`);
      // declares the wrong name → mismatch
      writeFileSync(join(dir, 'order.shipped.eventkit.js'), `module.exports = defineEvent({ name: 'order.WRONG', detector: () => true, jobs: [] });`);
      // generic form + name not first property → still found
      writeFileSync(join(dir, 'order.refunded.eventkit.ts'), `export const m = defineEvent<Row>({ detector, jobs: [job(fn, { name: 'inner' })], name: 'order.refunded' });`);
      // calls defineEvent but no literal name → missing-name
      writeFileSync(join(dir, 'order.void.eventkit.js'), `const n = computeName(); module.exports = defineEvent({ name: n, jobs: [] });`);
      // not an event module (no defineEvent) → skipped entirely
      writeFileSync(join(dir, 'helpers.js'), `module.exports = { foo: 1, name: 'not-an-event' };`);

      const mismatches = findEventNameMismatches({ dir, stripSuffixes: ['.eventkit'] });
      const byFile = Object.fromEntries(mismatches.map(m => [m.file.split('/').pop()!, m]));

      expect(Object.keys(byFile).sort()).toEqual(['order.shipped.eventkit.js', 'order.void.eventkit.js']);
      expect(byFile['order.shipped.eventkit.js']).toMatchObject({ expected: 'order.shipped', actual: 'order.WRONG', reason: 'mismatch' });
      expect(byFile['order.void.eventkit.js']).toMatchObject({ expected: 'order.void', actual: null, reason: 'missing-name' });
      // the matching + generic/name-last form + non-event files are NOT flagged
      expect(byFile['order.created.eventkit.js']).toBeUndefined();
      expect(byFile['order.refunded.eventkit.ts']).toBeUndefined();
      expect(byFile['helpers.js']).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('assert throws a single error listing every offender', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ek-eventnames-'));
    try {
      writeFileSync(join(dir, 'a.bad.js'), `module.exports = defineEvent({ name: 'nope', jobs: [] });`);
      expect(() => assertEventNamesMatchFilenames({ dir })).toThrow(/name 'nope' should be 'a.bad'/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
