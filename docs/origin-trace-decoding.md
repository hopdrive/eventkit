# Origin trace decoding: knowing which surface started a chain

A way for a frontend to say "this chain started here" without that ever becoming the
chain's identity. The client sends a registered action id as a trace header, eventkit
carries it through as conveyance, and a decoder you own turns it into display info that
shows up in observability and on the flow canvas.

It pairs with the chaining work in [chained-events.md](chained-events.md). Chaining keeps
one `correlation_id` across every invocation in a story. This adds a small, optional label
on the root invocation: where the story came from.

## The model

A browser sends a registered action id as the `x-b3-traceid` header on a Hasura mutation.
With Hasura's OpenTelemetry config on, that id lands in the event payload as
`event.trace_context.trace_id`. The Hasura source surfaces it verbatim on
`envelope.meta.sourceTraceId`.

The important rule: the trace id is a **conveyance channel, not the correlation id**. The
chain's correlation id is minted fresh at the root, exactly as if no trace id arrived. Two
reasons:

- A client that sends a static id per action (which is what makes decoding useful, see
  below) would otherwise merge every unrelated chain that used that action into one
  `correlation_id`. That is wrong: those are different stories.
- Chain identity should not be something a client gets to dictate. A client can send any
  trace id it likes.

So the Hasura source drops the trace id from the correlation fallback by default. If a
consumer genuinely wants the old behavior (a trusted internal caller that mints real,
unique trace ids per request), set `correlationFromTraceId: true` on the source. See the
behavior-change note at the bottom.

## The decoder lives in your codebase, not in eventkit

eventkit ships the **mechanism** (surface the trace id, run a decoder, inject the result),
not a codec. The `originDecoder` plugin takes a **required** `decode` function that you
supply:

```
decode: (traceId: string) => object | null
```

It returns a JSON-serializable object to show, or null for a trace id it doesn't recognize
(the plugin then does nothing). eventkit does not constrain the object's shape. The console
renders whatever is there.

### Primary pattern: a constant action registry

Keep an append-only array of the actions your frontends can start. Each entry has a stable
id that never changes or gets reused. The decoder looks up the full trace id:

```ts
// A file in your codebase, shared by the frontend (which sends the id) and the eventkit
// function (which decodes it). Append only. Never reuse or renumber an id.
export const ORIGIN_ACTIONS = [
  { id: 'act-move-create', action: 'move.create', site: 'dealer-portal', purpose: 'dealer creates a move' },
  { id: 'act-driver-assign', action: 'driver.assign', site: 'admin', purpose: 'dispatcher assigns a driver' },
  // { id: 'act-old-thing', ..., deprecated: true },
] as const;

const BY_ID = new Map(ORIGIN_ACTIONS.map(a => [a.id, a]));

export const decodeOrigin = (traceId: string) => BY_ID.get(traceId) ?? null;
```

Register the plugin with it:

```ts
import { createEventKit } from 'hopdrive-eventkit';
import { hasuraEvent } from 'hopdrive-eventkit/sources/hasura';
import { originDecoder } from 'hopdrive-eventkit/plugins/origin-decoder';
import { decodeOrigin } from './origin-actions';

const kit = createEventKit(hasuraEvent())
  .use(originDecoder, { decode: decodeOrigin })
  .registerEvents([/* ... */]);
```

What lands in `context_data.origin`:

```json
{ "action": "move.create", "site": "dealer-portal", "purpose": "dealer creates a move" }
```

The registry returns names itself, so there is no separate name-mapping option. Because the
ids are static per action and correlation is minted fresh, you do not need the ids to be
unique per request.

### Secondary pattern: a packed-format decoder

The injection point does not care how you decode. If you would rather pack fields into the
id than keep a registry, a decoder can unpack a composite id:

```ts
// e.g. "1.7.prod" = version 1, surface 7, env prod.
const decode = (traceId: string) => {
  const m = /^(\d+)\.(\d+)\.(\w+)$/.exec(traceId);
  if (!m) return null;
  return { idVersion: Number(m[1]), originId: Number(m[2]), env: m[3] };
};
```

This is just to show the mechanism supports fancier schemes. The registry is the
recommended default because it keeps names and meaning in one append-only place.

## Where it shows up, and ordering

`context_data` is serialized from `ctx.request.meta`. The only plugin hook that writes
`request.meta` is `configureInvocation`, so `originDecoder` uses it. `configureInvocation`
runs after `augmentEnvelope` (where the source set `meta.sourceTraceId`), so the trace id
is already on the envelope when the plugin runs.

The intent on the flow canvas: a decoded origin renders as a synthetic step to the LEFT of
the root invocation, so a chain reads as "started by the dealer portal, then this
invocation, then ...". Only **root** invocations decode to anything. A downstream hop
carries a Hasura-minted trace id (a real span id), not the client's action id, so the
decoder returns null and the plugin is a no-op on every hop. That is on purpose: origin is
a property of the chain root.

## Minting on the frontend

There is no minting. A button carries its registered action id in a data attribute, and the
Apollo/fetch layer copies that onto `x-b3-traceid`. The id is static per action.

```html
<button data-action-id="act-move-create" onclick="createMove()">Create move</button>
```

```ts
// In your Apollo link or fetch wrapper: read the action id off the element that started
// the request and send it as the trace header. No per-request id generation.
const actionId = triggerEl?.dataset.actionId;

client.mutate({
  mutation: CREATE_MOVE,
  variables,
  context: actionId ? { headers: { 'x-b3-traceid': actionId } } : undefined,
});
```

## Non-goals and the safety caveat

- **No timestamp, no user identity in the id.** The server's event time is already on the
  payload and the rows, and user identity arrives signed via `session_variables`. The trace
  id carries neither.
- **Display only, spoofable.** A client controls the trace id, so a decoded origin is a
  hint for labeling and grouping, never proof of origin and never an authz input. Anything
  that must be trusted still comes from `session_variables` or the server.
- **Static trace ids make real distributed tracing useless.** If you ever adopt Tempo or
  another tracing backend, static per-action ids collapse all traces for an action into one.
  The fix then (no eventkit change needed): mint an id as `actionCode + random suffix` on
  the frontend and make the decoder match on the action-code prefix.

## Behavior change

Before this change the Hasura source adopted `event.trace_context.trace_id` as the
correlation id when the request carried no explicit `correlationId`. It no longer does by
default: the correlation id is minted fresh, and the trace id is surfaced on
`meta.sourceTraceId` instead. Opt back in with `correlationFromTraceId: true` on the
`hasuraEvent` source if you need the old behavior. This pairs with Hasura's OTel / B3
propagation, verified separately in sdk PR #662.
