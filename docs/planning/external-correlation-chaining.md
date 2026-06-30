# Design: Closing the chain across an external vendor round-trip

**Status:** proposal (would ratify as **ADR-028**)
**Depends on:** §13 (tracking-token / loop-guard seam), ADR-024 (generic plugins, injected transports), the `source_job_id` parent-linkage convention.

> **Spike landed (core).** The framework change (§4.1, awaitable `augmentEnvelope`) and
> the `correlationResolver` plugin (§4) are implemented behind tests — `augmentEnvelope`
> is now awaited in `runtime/kit.ts`, `core/plugin.ts` widens the hook's return to allow
> a promise, and `plugins/correlation-resolver/` ships with the `./plugins/correlation-resolver`
> subpath export. 6 new tests cover lookup-recovers-lineage, the loop-guard end-to-end
> token continuation, echo-back stand-down (`skipIfResolved`), and the miss path. Full
> suite 112 passing; typecheck, contracts, build, and the bundle smoke gate all green.
> (The smoke list also had stale `batchjobs`/`loop-prevention` names from the earlier
> rename — fixed in the same pass.) **Still app-side / not in this spike:** §8 items 1–2
> (the query-param plumbing + the echo-back recipe), 5 (the `event_correlations` table +
> SDK accessors + per-vendor `extractKey`/`read`), and a live `ntl dev` proof.

---

## 1. The problem

EventKit already produces a fully connected **chain** for work that stays inside our
systems. A chain is the tree of invocations linked by two columns the Observability
plugin records:

- `correlation_id` — one id shared by the whole chain (the chain identity);
- `source_job_id` — each child invocation points at the *specific parent job* that
  caused it.

For DB→DB chains this works because **we own the write field**. A job stamps its
`ctx.trackingToken` (`source|correlationId|jobExecutionId`, §13) into `updated_by`; the
write fires a `hasuraEvent`; loop-guard's `augmentEnvelope` reads the token back out,
lifts its correlation id onto the new envelope (`correlationId` beats a fresh id), and
records `meta.sourceJobId` = the prior job. The chain stays whole, link by link.

That breaks the moment a link leaves our control:

```
  rideshare.requested (corr C)
      │
      └─ job J1  callVendorForRide ──HTTP──▶  ┌──────────────┐
                                              │  VENDOR       │  (knows nothing
                                              │  (black box)  │   about C or J1)
                                              └──────┬───────┘
                                                     │  ...minutes later...
   POST /webhooks/vendor  { ride_id: "V123", ... } ◀─┘
      │
      ▼
   webhook invocation W   ← mints a FRESH correlation id  ✗ chain severed
      │
      └─ job  sets rideshare.status='driver_assigned'  (updated_by stamped)
              │
              ▼
           hasuraEvent invocation X   ← correctly chains to W, but W is an orphan
```

In the Console you see two disconnected trees — `O → (vendor) → 💥` and `W → X` — when
the truth is one chain: *the customer's request caused the driver assignment*. The hole
is exactly the vendor round-trip: the vendor neither knows nor returns our correlation
id, so the inbound webhook starts a new chain.

The whole point of making webhooks/actions first-class non-DB sources (per
architecture.md §"Request/response is a general capability") was to see the **true origin
event** behind a cascade. This design closes the one gap that still severs it.

---

## 2. The key realization

`ctx.trackingToken` is *already* the breadcrumb we need. It encodes
`source|correlationId|jobExecutionId`, so recovering it on the inbound webhook recovers
**both** the chain id (`C`) **and** the parent job (`J1`) — the same two facts DB→DB
chaining recovers from `updated_by`.

So the design is not a new correlation system. It is: **make the inbound boundary recover
that token across the vendor hop**, feeding the *existing* loop-guard seam
(`envelope.correlationId` + `meta.sourceTrackingToken` + `meta.sourceJobId`). Everything
downstream — observability linkage, the next DB chain inheriting `C` — then works
unchanged.

There are exactly two ways to get the token back, depending on what the vendor will carry
for us.

---

## 3. Mechanism A — echo-back (the vendor returns our reference)

Some vendors round-trip an opaque field on their callbacks: Stripe `metadata` /
`client_reference_id`, Twilio `StatusCallback` query params, a generic
`external_reference` / `idempotency_key`. When one exists:

**Outbound (origin job J1).** Stamp our token into the echoed field. No framework change —
the job already has `ctx.trackingToken`:

```ts
export async function callVendorForRide(ctx) {
  const { sdk, rideshare } = ctx.input;
  return sdk.vendor.requestRide({
    pickup: rideshare.pickup,
    // the field THIS vendor echoes on every webhook for this object:
    metadata: { eventkit_token: ctx.trackingToken },   // "hopdrive|C|J1"
  });
}
```

**Inbound (webhook W).** loop-guard already extracts an inbound token — it just needs to
look in the right place for this vendor. loop-guard is config-driven (ADR-024) and exposes
a `read(envelope)` override and `getRow`; the webhook body is the "row," and headers are
in `envelope.meta.webhookHeaders`. So a per-vendor loop-guard reads the echoed token:

```ts
kit.use(loopGuard, {
  codec: { separator: '|', validateCorrelationId: true },   // HopDrive preset
  read: (env) => env.payload?.data?.object?.metadata?.eventkit_token   // Stripe shape
              ?? env.meta?.webhookHeaders?.['x-eventkit-token'],
});
```

loop-guard parses it, sets `envelope.correlationId = C`,
`meta.sourceTrackingToken = hopdrive|C|J1`, `meta.sourceJobId = J1`. **Chain reconnected
with full parent-job precision, zero runtime changes** — this is pure config on top of
what ships today.

> Coverage gap to close (small): the webhook source surfaces headers in
> `meta.webhookHeaders` but **not** query-string params. Stripe/Twilio callbacks often
> carry the reference in the query string. Fix: have the HTTP platform adapters put parsed
> query params in `request.meta.query`, and the webhook `normalize` copy them to
> `meta.webhookQuery`. Then `read` can reach them. (Config/plumbing, not a new concept.)

---

## 4. Mechanism B — DB lookup (the vendor only returns *its* id)

Most vendors will **not** echo arbitrary metadata; the only correlating handle on the
webhook is the vendor's own `ride_id`. Then we must have persisted the mapping ourselves
at call time and look it up on the way in.

**Outbound (origin job J1).** After the vendor returns `V123`, persist
`V123 → trackingToken`. Recommended: a dedicated, vendor-agnostic table rather than
polluting the domain row —

```ts
// inside callVendorForRide, after the vendor responds:
const { vendor_ride_id } = await sdk.vendor.requestRide(/* … */);
await sdk.eventCorrelations.insert({
  vendor: 'acme',
  external_id: vendor_ride_id,          // "V123"
  tracking_token: ctx.trackingToken,    // "hopdrive|C|J1"
  correlation_id: ctx.correlationId,
});
```

**Inbound (webhook W).** This is the one case that needs an *async* step — a DB query —
*before* the correlation id locks. A new generic plugin, the **correlation resolver**,
does it. Like every I/O plugin (ADR-024) it never reads the DB itself; the app injects the
`lookup`:

```ts
kit.use(correlationResolver, {
  // pull the vendor's id out of THIS vendor's webhook body:
  extractKey: (env) => ({ vendor: 'acme', externalId: env.payload?.ride_id }),
  // injected: the app's SDK/DB query. async.
  lookup: async ({ vendor, externalId }) => {
    const row = await sdk.eventCorrelations.findOne({ vendor, external_id: externalId });
    return row && { correlationId: row.correlation_id, trackingToken: row.tracking_token };
  },
  // optional: what to do on a miss (default: leave the fresh id, log a "chain-root" gap)
});
```

It resolves `{ correlationId, trackingToken }`, then sets the *same* envelope fields
loop-guard sets — so from that point on the two mechanisms are indistinguishable
downstream.

### 4.1 The one framework change: an awaitable envelope seam

Today `augmentEnvelope` is **synchronous** (`plugin-manager.ts:183`, not awaited at
`kit.ts:216`), and the correlation id locks right after (`kit.ts:226`). A DB lookup can't
run there. The minimal, backward-compatible change:

> **Make the `augmentEnvelope` merge `await` each plugin's return.** Sync plugins
> (loop-guard) are unaffected — you just `await` a non-promise. The resolver returns a
> `Promise<Partial<EventEnvelope>>`. Registration-order folding is preserved. The
> correlation lock at `kit.ts:226` still runs after, now reading the resolved id.

```ts
// plugin-manager.ts — augmentEnvelope becomes async:
async augmentEnvelope(envelope) {
  let merged = envelope;
  for (const p of this.plugins) {
    const partial = await p.augmentEnvelope?.(merged);   // await tolerates sync + async
    if (partial) merged = { ...merged, ...partial, meta: { ...merged.meta, ...partial.meta } };
  }
  return merged;
}
// kit.ts:216 — envelope = await this.pm.augmentEnvelope(envelope);
```

**Alternative considered:** a dedicated async hook `resolveCorrelation(env)` separate from
`augmentEnvelope`, preserving the "augmentEnvelope is sync" guarantee. Rejected as the
default because it adds a second concept for the same job (mutate the envelope before the
id locks) and the resolver and loop-guard would live on different hooks despite doing the
same thing. Prefer one seam. (Offered as the fallback if we want to keep the sync
guarantee — see Decision D3.)

> **Latency note (honest):** Mechanism B adds an awaited round-trip on the inbound hot
> path. Only invocations whose kit registers the resolver pay it, and it is inherent to
> the lookup approach. Echo-back (A) has no such cost — prefer A whenever the vendor
> supports it.

---

## 5. Why both, and how they compose

| | Mechanism A (echo) | Mechanism B (lookup) |
|---|---|---|
| Needs vendor to round-trip a field | yes | no |
| Outbound cost | stamp a field on the call | one extra write (mapping) |
| Inbound cost | none (sync extract) | one DB read (async) |
| Framework change | none (+ query-param plumbing) | awaitable `augmentEnvelope` |
| Parent-job precision | full (token) | full (token) |

They are not mutually exclusive: configure A as the fast path and B as the fallback —
loop-guard runs first (sets `C` if the token was echoed), and the resolver only fires when
no correlation was recovered (`if (env.correlationId is still fresh) lookup(...)`). A
vendor that echoes for some event types but not others is then fully covered.

Both keep EventKit generic: the codec, loop-guard, and resolver carry nothing
HopDrive-specific; the app injects the echoed-field accessor and the `lookup` closure,
exactly like `sink`/`store` (ADR-024).

---

## 6. hasuraAction angle

The same seam covers actions, in both directions:

- **Action as chain *root* that calls a vendor:** identical to §3/§4 — the action's
  `resolve`/jobs stamp `ctx.trackingToken` onto the vendor call (A) or persist the mapping
  (B); the eventual webhook reconnects.
- **Action *joining* an existing chain:** a client that already holds a correlation id
  passes it as `x-correlation-id` (or `x-request-id`). loop-guard's `extractFromSession`
  already reads those session variables, and the action source already folds
  `request.correlationId` in `normalize`. So a client-initiated action slots into a chain
  with no new code — worth a test to lock the behavior.

---

## 7. Visualization payoff

Once W carries `correlation_id = C` and `source_job_id = J1`, the Console can render the
whole thing as one tree, vendor hop included:

```
corr C ─ rideshare.requested  (invocation O)
         └─ job J1  callVendorForRide  ──▶ [vendor V123]
                                            └─▶ vendor.ride.driver_assigned (invocation W)   source_job_id = J1
                                                 └─ job  set status      ──writes──▶
                                                          rideshare row updated (invocation X)   source_job_id = W's job
```

Optional enrichment (not required for chaining): J1 records its `external_ref: V123` as
job output, so the Console can draw a *pending* edge from J1 to "awaiting vendor" and
resolve it visually when W arrives carrying V123 — turning the black-box hop into a
first-class, latency-measurable span.

---

## 8. Scope of work

1. **No-change, ships today:** Mechanism A for any vendor that echoes into the body —
   per-vendor `loopGuard({ read })`. Document the recipe.
2. **Small plumbing:** surface webhook query params (`request.meta.query` →
   `meta.webhookQuery`) so A covers query-string references (Stripe/Twilio).
3. **One framework change:** make `augmentEnvelope` awaitable (§4.1).
4. **New generic plugin:** `correlationResolver({ extractKey, lookup, onMiss? })` on that
   seam (Mechanism B).
5. **HopDrive presets/recipes (in app code, not the package):** the `event_correlations`
   table + SDK accessors, the `lookup` closure, the per-vendor `extractKey`/`read`.
6. **Tests:** echo round-trip reconnects `C`; lookup round-trip reconnects `C`; action
   joins a chain via `x-correlation-id`; resolver miss leaves a clean new root (no crash).

---

## 9. Decisions to ratify

- **D1 — Mapping storage (Mechanism B):** dedicated `event_correlations` table vs. a
  column on the domain row. *Recommend the table* — vendor-agnostic, many-to-one capable,
  doesn't touch domain schema, and is queryable for orphan-chain audits.
- **D2 — Resolver as its own plugin vs. an async option on loop-guard.** *Recommend its
  own plugin* — keeps loop-guard sync and pure; both still feed one envelope seam.
- **D3 — Awaitable `augmentEnvelope` vs. a separate `resolveCorrelation` hook.**
  *Recommend awaitable `augmentEnvelope`* (one concept); fall back to the dedicated hook
  only if we decide the sync guarantee is worth a second hook.
- **D4 — Echo payload: full token vs. bare correlation id.** *Recommend the full token*
  (recovers the parent job id too), falling back to a bare id when a vendor caps field
  length.
