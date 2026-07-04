---
'hopdrive-eventkit': patch
---

Docs & tooling housekeeping after the npm rename to `hopdrive-eventkit`:

- Correct all README and `docs/guide.html` import/install examples to the published
  name (`hopdrive-eventkit`, e.g. `import { … } from 'hopdrive-eventkit/plugins'`) so
  copy-paste works for consumers.
- Derive the `docs-compile` doc-drift gate's scan regex from `package.json` "name"
  instead of a hardcoded scope, so a future rename can't silently turn the gate into a
  zero-match no-op. The gate now validates 50 documented import names again.
- Console app: bump `jsondiffpatch` 0.6.2 → 0.7.2 (Dependabot; dev-only, not part of the
  published package).
