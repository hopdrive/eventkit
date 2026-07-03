---
'@hopdrive/eventkit': patch
---

Fix dual-package type resolution: CJS consumers no longer get types "masquerading as ESM".

`package.json` "exports" now provide per-condition `types` — ESM declarations (`dist/esm/*.d.ts`, under the `type: module` marker) for the `import` condition and CJS declarations (`dist/cjs/*.d.ts`, under the `type: commonjs` marker) for the `require` condition, instead of a single ESM-flavored `dist/types` shared by both. This resolves the `are-the-types-wrong` "FalseESM" finding for `node16` CJS consumers across all 16 subpaths; ESM and bundler resolution are unchanged. attw (node16 profile) is now a CI gate to prevent regressions.
