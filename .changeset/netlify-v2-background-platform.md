---
'hopdrive-eventkit': minor
---

Add `netlifyV2BackgroundPlatform` for Netlify Functions 2.0 background functions.

The modern Netlify v2 `(Request, Context) → Response` shape for a function declared
`export const config = { background: true }` (no `-background` filename suffix). It reuses
`netlifyV2Platform`'s Web-Request plumbing but runs as a deferred-response platform:
`deferredResponse: true` (blocks result-driven `respond` modules), a ~15-minute default
budget, and a `202` `Response`. Import from `hopdrive-eventkit/platforms`.
