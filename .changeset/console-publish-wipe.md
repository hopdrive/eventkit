---
'hopdrive-eventkit': patch
---

Ship dist/console in the npm tarball again. `npm publish` re-runs the `prepare`
lifecycle (the core build) while packing, and its `clean` step removed all of
`dist/`, wiping the console bundle that `build:console` had just produced. Every
publish since the console shipped (0.4.0 through 0.6.0) declared the `./console`
export but was missing the files, which broke consumers' typecheck with
"Cannot find module 'hopdrive-eventkit/console'". `clean` now only removes
`dist/esm` and `dist/cjs`.
