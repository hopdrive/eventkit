---
'@hopdrive/eventkit': minor
---

testing: add `assertEventNamesMatchFilenames` / `findEventNameMismatches` to
`@hopdrive/eventkit/testing` — a test-time check that each event module's declared
`name` matches its file name (the ADR-025 one-module-per-file convention, e.g.
`appointment.ready.ts` → `defineEvent({ name: 'appointment.ready' })`).

The check is exact and unconfigurable: the filename stem (basename minus its extension)
must equal the declared `name` — no suffix stripping. TypeScript can't tie a string
literal to a filename, so this runs at test/CI time — but it reads SOURCE TEXT (never
imports the module), so it has no import side effects, needs no env, and is unaffected by
bundling. It auto-discovers event modules (any file containing a `defineEvent({ … })`
call) under the given dir(s); dispatchers, jobs, helpers, and legacy non-`defineEvent`
modules are skipped. A brace-depth scanner extracts the module's TOP-LEVEL `name` (never a
nested job name), so property order doesn't matter; a computed/missing name is flagged as
`missing-name`. Options: `dir`, `extensions`, `ignore`. Drop one test in per repo:

    import { assertEventNamesMatchFilenames } from '@hopdrive/eventkit/testing';
    it('event names match filenames', () => assertEventNamesMatchFilenames({ dir: 'functions' }));
