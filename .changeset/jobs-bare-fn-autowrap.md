---
'@hopdrive/eventkit': minor
---

ADR-025 amendment: a `jobs` entry may be a bare job function (sugar for `job(fn)`).

`EventModule.jobs` widens to `(JobDefinition<any> | JobFunction<any>)[]`. A bare function is
auto-wrapped as `job(fn)` (no options) at register time, with its name from `fn.name`:

    defineEvent({ name: 'move.active.change', detector, jobs: [runAR, runARV2, runDriverPay] })

Wrap in `job(fn, {…})` only when a job needs options (`name`/`retries`/`input`/`timeoutMs`);
bare and wrapped may be mixed. This does NOT reopen conditional inclusion (ADR-025): `cond && fn`
(`false | JobFunction`) and `cond && job(fn)` (`false | JobDefinition`) still fail to compile, and
`null`/look-alike objects are rejected at compile time and by the register/runtime backstop. The
job set stays statically enumerable, so observability/flow tooling is unaffected. The example +
local proof modules drop `job()` where they passed no options.
