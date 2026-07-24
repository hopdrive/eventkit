# Origin ids: knowing which surface started a chain

A structured trace/correlation id that a frontend mints and that says, when you decode
it later, which app or service started the chain and in which environment.

It pairs with the chaining work in [chained-events.md](chained-events.md). Chaining keeps
one `correlation_id` across every invocation in a story. An origin id makes that same id
carry a little bit of provenance: the surface that kicked it off. So the console can label
a chain "started by the driver app, in prod" even when nothing else about the origin
survived the hops.

## The idea in one paragraph

A browser generates a 32-hex id and sends it as the `x-b3-traceid` header on a Hasura
mutation. With Hasura's OpenTelemetry config on, that id shows up in the event payload as
`event.trace_context.trace_id`, and `normalizeHasuraEvent` already adopts it as the
invocation's `correlationId`. loopGuard then chains that id across the whole
write -> event -> write story, so every invocation in the chain shares it. Decode the id
and you learn the surface and env that started everything. The Hasura OTel / B3 half of
this is verified separately in sdk PR #662.

## The format

32 hex characters (128 bits). Every field is nibble-aligned, most significant first:

| hex chars | bits   | field    | meaning                                                    |
| --------- | ------ | -------- | ---------------------------------------------------------- |
| 0-5       | 0-23   | magic    | constant `c0ffee`. Marks the id as a structured origin id. |
| 6         | 24-27  | version  | this spec is version 1.                                    |
| 7-8       | 28-35  | originId | 0-255. Opaque number for the minting surface.              |
| 9-10      | 36-43  | flags    | bits 0-2 = env; bits 3-7 reserved, written zero.           |
| 11-31     | 44-127 | random   | 84 random bits.                                            |

env is the low 3 bits of the flags byte:

| env | name     |
| --- | -------- |
| 0   | unknown  |
| 1   | prod     |
| 2   | test     |
| 3   | preview  |
| 4   | local    |
| 5-7 | reserved |

The codec knows numbers, not names. Mapping an `originId` number (say `7`) to a display
name (`driver-app`) is your config, passed to the decoder plugin as `originNames`. That
keeps the id small and keeps naming a deploy-time decision, not something baked into the id.

The reserved flag bits are written as zero today. A decode does NOT reject an id with
reserved bits set (forward compatibility): it returns the raw `flags` byte so a later
version can read them. A decode DOES return null for any version other than 1, so an
older consumer treats a future id as opaque instead of misreading it.

## Minting one in a frontend

The codec is dependency-free and runs in the browser. Encode an id and put it on the
`x-b3-traceid` header of your GraphQL request.

Apollo:

```ts
import { encodeOriginId } from 'hopdrive-eventkit/core';

// 7 = this app's assigned originId; env 1 = prod. Pick a fresh id per user action you
// want to trace (per mutation, or per logical flow).
const traceId = encodeOriginId({ originId: 7, env: 1 });

client.mutate({
  mutation: CONFIRM_APPOINTMENT,
  variables,
  context: { headers: { 'x-b3-traceid': traceId } },
});
```

Plain fetch:

```ts
import { encodeOriginId } from 'hopdrive-eventkit/core';

await fetch('/v1/graphql', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-b3-traceid': encodeOriginId({ originId: 7, env: 1 }),
  },
  body: JSON.stringify({ query, variables }),
});
```

`encodeOriginId` throws on an out-of-range `originId` (not an integer 0-255) or `env`
(not an integer 0-7), so a bad value fails at the call site instead of minting a junk id.

## Decoding on the server

Register the `originDecoder` plugin. For each invocation it decodes the final correlation
id and, when it is an origin id, drops an `origin` object into the invocation's request
meta. Observability persists that as `context_data.origin`, and the console reads it there.

```ts
import { createEventKit } from 'hopdrive-eventkit';
import { hasuraEvent } from 'hopdrive-eventkit/sources/hasura';
import { loopGuard } from 'hopdrive-eventkit/plugins/loop-guard';
import { originDecoder } from 'hopdrive-eventkit/plugins/origin-decoder';

const kit = createEventKit(hasuraEvent())
  .use(loopGuard, { codec: { separator: '|', validateCorrelationId: true } })
  .use(originDecoder, {
    // Map your assigned originId numbers to display names for the console.
    originNames: { 7: 'driver-app', 42: 'confirmations' },
  })
  .registerEvents([
    /* ... */
  ]);
```

What lands in `context_data.origin`:

```json
{
  "idVersion": 1,
  "originId": 7,
  "originName": "driver-app",
  "env": 1,
  "envName": "prod"
}
```

`originName` is present only when your `originNames` map has an entry for that number. On
an id it can't decode (wrong magic, unknown version, or just a plain random correlation
id), the plugin does nothing at all, so a chain with no origin id behaves exactly as it
does today.

### Ordering

loopGuard (and correlationResolver, if you use it) recover the chain's correlation id
during `augmentEnvelope`. `originDecoder` decodes during `configureInvocation`, which runs
after `augmentEnvelope` in the pipeline, so it always sees the chain's final correlation
id no matter where it sits in the registration list. On a chained hop the recovered id is
the chain ROOT's id, so every invocation in the chain decodes to the same origin. That is
on purpose: the origin belongs to the chain, not to one hop. Registering `originDecoder`
after loopGuard is the clean convention.

### Custom decoder

If a surface mints ids with a different scheme, pass your own `decode` function. It has
the same contract as the built-in one: return the decoded fields, or null for an id it
doesn't understand.

```ts
kit.use(originDecoder, { decode: id => myScheme.decode(id) });
```

## Non-goals

Version 1 deliberately does NOT pack:

- **A timestamp.** The server's event time is already on the payload and on the rows. No
  reason to duplicate it in the id, and a clock is not the frontend's to be trusted with.
- **User identity.** That arrives signed via `session_variables`. Putting it in a
  client-minted id would be both redundant and unsafe.

And the big one: an origin id is **display-only and spoofable**. A client mints it, so a
client can lie about it. Treat a decode as a hint about where a chain came from, good for
labeling and grouping in the console, never as proof of origin and never as an authz
input. Anything that must be trusted still comes from `session_variables` or the server.
