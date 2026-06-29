---
'@hopdrive/eventkit': minor
---

grafana plugin: redesign as a log **bridge** with two modes instead of a hard-coded Loki transport.
Renamed `grafanaTransport` → `grafanaLogger`. It no longer assumes it owns the Loki endpoint/payload:

- **Injected logger (HopDrive path):** pass `logger` (e.g. `getLogger()` from
  `@hopdrive/sdk-server-logger`). The plugin forwards `onLog`/`onJobLog`/`onError` straight to it
  with structured metadata, exactly like the legacy `grafanaLoggerPlugin`. The SDK owns the Loki
  URL, payload shape, label trimming, auth and queue flush — eventkit never touches them and takes
  no dependency on the SDK. Flush stays the consumer's job (`withLoggingInit`) unless an optional
  `flush` seam is injected.
- **Direct Loki (standalone path):** pass `grafana: { endpoint, auth, labels }` and the plugin builds
  its own Loki-backed sink and flushes at `onFlush` (the previous behavior, now opt-in).

Throws if neither `logger` nor `grafana` is provided.
