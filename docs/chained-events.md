# Chained events: keeping one story across many invocations

> **Status:** proven end to end on 2026-07-02 against a local Hasura (v2.26) with two
> EventKit functions, a real mutation-driven chain, and a simulated vendor round trip.
> Relies on two small package changes that are still in review: loop-guard parsing full
> tokens from session variables, and correlation-resolver carrying hop depth forward.
> The internal design memo for the vendor piece is
> [planning/external-correlation-chaining.md](planning/external-correlation-chaining.md) (ADR-028).

## Why you want this

One business action rarely stays inside one function invocation. An order gets created.
A job calls a partner. The partner calls back later. That callback updates a row. The
row update fires another event, which runs more jobs. Without chaining, observability
shows you five or six disconnected invocations and you get to guess how they relate.

With chaining, every invocation in that story shares one `correlation_id`, and every
child invocation records `source_job_id`, the exact job execution that caused it. The
whole story becomes one tree you can query, render, and reason about. Chaining is also
what makes loop protection real. Hop depth only means something if the token actually
survives every hop.

Here is an actual chain from the proof run. One INSERT produced all of this:

```
#1 INSERT eventkit_partner_orders          -> order.created
      job requestPartnerService  (hop 1)   calls the partner API, persists ref -> token
#2 UPDATE (partner_ref stamped)            -> no events detected, still chained to #1
#3 webhook: pickup.scheduled               <- chained to #1 by DB LOOKUP of the ref
      job markScheduled          (hop 2)   sets status='scheduled', token in header
#4 UPDATE status                           -> order.status.changed, chained to #3
      job stampTimeline          (hop 3)
#5 UPDATE timeline                         -> no events detected, chained to #4
#6 webhook: pickup.completed               <- chained to #1 by DB lookup
      job markCompleted          (hop 2)
#7 UPDATE status                           -> order.status.changed, chained to #6
      job stampTimeline          (hop 3)
#8 UPDATE timeline                         -> chained to #7
```

Eight invocations, two different sources (Hasura events and vendor webhooks), one
correlation id. Note the branching: #3 and #6 both point at #1's job, because both
partner callbacks came from that one API call. Chains are trees, not lines.

## The tracking token

Everything rides on one small string:

```
source | correlationId | jobExecutionId | hopDepth
chain-poc|2da00667a56b207240c703f72ec5360a|ebcbecc4-...|1
```

- **source**: the service that minted the token (the loop-guard `serviceId`). It stays
  the same for the life of the chain, even across services. Later services continue the
  token, they do not re-mint it.
- **correlationId**: the chain identity. Shared by every invocation in the tree.
- **jobExecutionId**: the job that is about to cause the next event. This becomes the
  child invocation's `source_job_id`.
- **hopDepth**: optional counter for loop ceilings. Present when depth tracking is on.

Jobs never build this by hand. Loop-guard puts a ready token on every job context as
`ctx.trackingToken`, continuing the inbound lineage when there is one and minting a
fresh token when the invocation is a chain root.

## How a link works

Every link in a chain is the same two moves:

1. **Outbound**: a job causes a side effect (a DB write, an API call) and the token
   goes with it, on whatever channel that side effect supports.
2. **Inbound**: the resulting event arrives somewhere, and a plugin recovers the token
   from that channel before dispatch. The recovered correlation id replaces the fresh
   one, `source_job_id` gets recorded, and hop depth ticks up by one.

There are three channels. Pick per side effect, not per repo. A single chain can and
usually will cross all three.

## Channel 1: Hasura session variables (the header channel)

This is the preferred channel for DB writes that go through Hasura, and it was the
big discovery of the proof. **The token never touches the row.**

Hasura forwards any header prefixed `x-hasura-*` on an admin-secret request into the
event trigger payload as a session variable. So the job sends its mutation like this:

```js
await fetch(config.graphqlUrl, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-hasura-admin-secret': config.graphqlSecret,
    'x-hasura-tracking-token': ctx.trackingToken,   // the whole channel
  },
  body: JSON.stringify({ query, variables }),
});
```

and the next event arrives with:

```json
"session_variables": {
  "x-hasura-role": "admin",
  "x-hasura-tracking-token": "chain-poc|2da00667...|ebcbecc4-...|1"
}
```

On the receiving side, loop-guard reads it back out:

```js
.use(loopGuard, {
  serviceId: 'my-service',
  codec: { separator: '|', validateCorrelationId: false },  // see gotchas
  extractFromUpdatedBy: false,      // headers only, the row is never consulted
  extractFromMetadata: false,
  sessionVariables: ['x-hasura-tracking-token'],
  warnAtDepth: 8,
  haltAtDepth: 12,
})
```

Why this beats stamping `updated_by`:

- No schema or data pollution. `updated_by` stays whatever your app wants it to be.
- Nothing to forget in the mutation body. The header is uniform across every mutation,
  which makes it automatable (a shared client or SDK helper can attach it to every
  request without knowing anything about the mutation's shape).
- No extra UPDATE noise. The token changes per hop; a stamped column makes every write
  dirty even when nothing meaningful changed.

Know the limits:

- **The prefix is mandatory.** A header named anything not starting with `x-hasura-`
  is silently dropped. This is the number one reason people conclude the pass-through
  "does not work."
- **Admin secret requests only** get arbitrary `x-hasura-*` headers through. JWT and
  webhook-auth requests only carry the session variables their auth layer produces.
  Server-side jobs use the admin secret, so this fits our event functions.
- **Only writes through Hasura GraphQL carry session variables.** Direct SQL, other
  services writing to Postgres, migrations: the event still fires, but
  `session_variables` is null. Those writers need channel 2.
- **Replay changes shape.** Re-firing an event by flipping a row's status will not
  reconstruct a header-borne token. If the replayer wants the chain, it must set the
  header itself.

## Channel 2: the write field (`updated_by`)

The legacy channel, and still the durable fallback. The job stamps `ctx.trackingToken`
into the row's `updated_by` (or a configured field), and loop-guard's default
extraction reads it back on the next event. Use it when the writer cannot send headers
through Hasura, or when you want the token to survive on the row for replay and audit.

Both channels can be on at once. Loop-guard checks the write field first, then session
variables, so a row token wins when present and the header covers everything else.

## Channel 3: vendor round trips (correlation-resolver)

The hard one. A job calls a partner API. Minutes later the partner posts a webhook.
Real vendors do not echo your metadata back; the webhook carries only the **vendor's
own resource id**. The chain has to survive on your side of the fence.

The pattern has two halves.

**At call time, persist the mapping.** The origin job saves `vendor ref -> token` the
moment the partner acks:

```js
const requestPartnerService = async ctx => {
  const { input, trackingToken, correlationId } = ctx;
  const ack = await callPartnerApi(input);          // partner returns { ref }
  await gqlWithToken(`mutation Persist(...) {
    update_orders_by_pk(...)                        # stamp partner_ref on the order
    insert_eventkit_correlation_refs_one(object: {
      vendor: "partnerco",
      external_ref: $ref,
      tracking_token: $token,
      correlation_id: $corr
    }) { id }
  }`, { ... }, trackingToken);
  return { partnerRef: ack.ref };
};
```

The mapping table is correlation infrastructure. Track it for GraphQL access, but do
**not** put an event trigger on it.

**At webhook time, look the lineage back up.** The webhook function registers
`correlationResolver` after loop-guard. You give it two functions: how to pull the
vendor's key off the body, and how to turn that key into the stored lineage:

```js
.use(loopGuard, { serviceId: 'partner-webhooks', ... })   // still owns outbound tokens
.use(correlationResolver, {
  extractKey: envelope => envelope.payload?.ref,
  lookup: async ref => {
    const row = await queryCorrelationRefs('partnerco', ref);   // your DB read
    return row ? { correlationId: row.correlation_id, trackingToken: row.tracking_token } : null;
  },
  codec: { separator: '|' },
  onLookupError: 'reject',   // a DB blip 503s so the vendor redelivers
  onMiss: (envelope, key) => log.warn(`no lineage for ref ${key}, starting a fresh chain`),
})
```

The resolver rides the same envelope seam loop-guard uses, and sets the same fields.
Downstream, a resolver-recovered hop is indistinguishable from an inline-token hop:
same correlation id, same `source_job_id` link, and the hop counter keeps counting
(so `haltAtDepth` cannot be evaded by bouncing a chain off a vendor).

Two decisions worth making consciously:

- **`onLookupError`**: `'reject'` means a lookup failure returns a 5xx and the vendor
  retries. Use it when the chain link is load bearing. The default `'ignore'` records
  the invocation as an orphan root and moves on. Either way the webhook itself is not
  lost.
- **`skipIfResolved`** (default true): when a vendor does happen to echo your token
  (some let you attach metadata), loop-guard's cheap inline extraction wins and the
  DB read never happens. Configure both and the resolver becomes the fallback.

## Querying a chain

Everything lands in the observability tables. The chain identity is `correlation_id`,
the parent link is `invocations.source_job_id -> job_executions.id`.

```graphql
query Chain($corr: String!) {
  invocations(where: {correlation_id: {_eq: $corr}}, order_by: {created_at: asc}) {
    id created_at source_function source_table source_operation source_job_id status
  }
  job_executions(where: {correlation_id: {_eq: $corr}}, order_by: {created_at: asc}) {
    id invocation_id job_name status
  }
}
```

Walk it: an invocation's `source_job_id` tells you the parent job, the parent job's
`invocation_id` tells you the parent invocation. Roots have `source_job_id` null.
Invocations that detected nothing still chain (see #2, #5, #8 in the proof tree), so
the tree has no dead ends.

## Loop protection

Chains are how event loops happen: A's write fires B, B's write fires A. Loop-guard's
hop ceiling turns an infinite loop into a bounded one, but only if the depth actually
accumulates. Every dropped token resets the counter to zero. That makes the channels
above a safety feature, not just an observability feature. Configure both knobs:

```js
warnAtDepth: 8,    // log a loud breadcrumb, keep going
haltAtDepth: 12,   // suppress dispatch entirely, log why
```

Set the ceiling well above your deepest legitimate chain. The proof chain above peaks
at hop 3.

## Gotchas from the proof

These all bit us in the live run. Learn from our bruises.

1. **`x-hasura-` prefix or nothing.** Custom headers without the prefix never reach
   `session_variables`. If your pass-through test "fails", check the prefix first.
2. **`validateCorrelationId: true` breaks the header channel today.** The Hasura source
   adopts the payload's `trace_context.trace_id` as the root correlation id. That is 32
   hex characters with no dashes, so the codec's UUID check rejects every token built
   from it, silently, and the extraction falls back to treating the whole token as a
   bare correlation id. Tokens nest inside tokens and the chain looks insane. This is
   decided now (ADR-040): the codec will accept UUIDs and dashless 32-hex ids, and
   trace-id adoption stays. Until that ships, run with `validateCorrelationId: false`.
3. **The mapping insert must not trigger events.** If you put an event trigger on the
   correlation-refs table you will chain your chain bookkeeping.
4. **Do not expect the vendor to give your ids back.** Design the webhook modules
   around the vendor's ref from day one. Updating rows "by ref" instead of by pk keeps
   the webhook jobs honest about what they actually know.
5. **The status quo is invisible until you look.** Before this setup, every webhook
   invocation was silently starting a fresh chain. Nothing errored. If you want to know
   where chains break today, query invocations with null `source_job_id` and ask
   whether each one is really a root.

## Checklist for a new chained flow

On the event-function side (Hasura source):

- [ ] `loopGuard` registered with your `serviceId`, `sessionVariables:
      ['x-hasura-tracking-token']`, and depth ceilings
- [ ] every job mutation goes through a helper that attaches
      `x-hasura-tracking-token: ctx.trackingToken`
- [ ] observability plugin wired with the graphql sink

On the webhook-function side (vendor source):

- [ ] `webhook({ vendor, eventTypeHeader, verify, rejectUnverified })` with a real
      verify preset
- [ ] one named module per webhook event type, routed by `ctx.eventType`
- [ ] `loopGuard` registered (owns outbound tokens even here)
- [ ] `correlationResolver` registered after loop-guard with `extractKey`, `lookup`,
      and a deliberate `onLookupError` choice

On the origin job for any partner call:

- [ ] persist `vendor ref -> tracking_token` (and `correlation_id`) the moment the
      partner acks
- [ ] the mapping table is tracked but has no event trigger
