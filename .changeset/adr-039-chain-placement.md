---
'@hopdrive/eventkit': minor
---

Chain-concern placement (ADR-039) — **BREAKING** for `loopGuard` configs.

The chaining machinery is re-homed along the layering rules: the codec in core, inbound discovery in sources, cross-source policy in the generic plugin, outbound injection in the write layer.

- **Codec → core.** The tracking-token codec now lives at `core/tracking-token.ts` and is exported from `@hopdrive/eventkit/core` (`createTokenCodec`, `isCorrelationIdShape`, `TokenCodec`, `TokenCodecConfig`, `TokenComponents`). `@hopdrive/eventkit/plugins/loop-guard` keeps re-exporting it, and `correlationResolver` no longer imports from inside another plugin's folder.
- **Sources own inbound token discovery.** A source may surface ordered candidates at `envelope.meta.tokenCandidates` (a documented `SourceMeta` field) during normalize. The Hasura family reads its two channels — the row write field (`tokenField`, default `'updated_by'` with `updatedby`/`updated_by` fallbacks) then session variables (`tokenSessionVariables`, default `['x-hasura-tracking-token']`) — configured on the SOURCE: `createEventKit(hasuraEvent, { tokenField, tokenSessionVariables })`. `hasuraEvent`/`hasuraCron`/`hasuraAction` are now callable factories (bare use is unchanged). The webhook and application sources surface no candidates (`correlationResolver` is the webhook recovery path).
- **BREAKING: `loopGuard` sheds all payload anatomy.** Removed config: `field`, `read`, `getRow`, `getSession`, `extractFromUpdatedBy`, `extractFromMetadata`, `extractFromSession`, `extractFromCustomField`, `updatedByPattern`, `sessionVariables`, `metadataKeys`. It now consumes `meta.tokenCandidates` (plus a generic `candidates: (envelope) => string[]` escape hatch): the first candidate that parses as a full token wins (correlation id, `sourceJobId`, hop depth, `sourceTrackingToken`); a bare UUID/32-hex candidate still chains as a bare correlation id (and no longer masquerades as a `sourceTrackingToken`). Depth ceilings and the ambient `ctx.trackingToken` are unchanged.
- **`hopdriveLoopGuard` preset** (the §13/D23 preset, finally shipped): pins `codec: { separator: '|', validateCorrelationId: true }` and requires `serviceId`. Pairs with the Hasura source defaults (`updated_by` + `x-hasura-tracking-token`). From `@hopdrive/eventkit/plugins`.
- **`hasuraChainedClient({ endpoint, headers, timeoutMs })`** — the outbound paved road through the existing ADR-020 input seam: contributes `ctx.input.gql`, a dependency-free fetch wrapper that stamps `x-hasura-tracking-token: ctx.trackingToken` on every request and returns parsed `data` (throws `GraphqlRequestError` on GraphQL errors). Handler-supplied input keys still win. From `@hopdrive/eventkit/sources/hasura`.

Migration for a chain-participating Hasura function:

```js
// before
.use(loopGuard, { serviceId, codec: { separator: '|', validateCorrelationId: false },
  extractFromUpdatedBy: false, extractFromMetadata: false,
  sessionVariables: ['x-hasura-tracking-token'], warnAtDepth: 8, haltAtDepth: 12 })

// after (source defaults already read updated_by + x-hasura-tracking-token)
.use(hopdriveLoopGuard, { serviceId, warnAtDepth: 8, haltAtDepth: 12 })
```
