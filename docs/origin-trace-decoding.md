# Origin decoding: which frontend action started a chain

Label each chain of invocations with the frontend action that set it off, so
observability and the flow console can show "a dealer created a move" next to the
database write instead of just the write.

The frontend sends a short id for the action a user took. eventkit hands that id to a
`decode` function you write, and whatever `decode` returns lands at `context_data.origin`
on the first invocation of the chain. The console reads it and draws a node showing the
action, who did it, and when.

This sits next to chaining (see [chained-events.md](chained-events.md)), which keeps one
correlation id across every invocation in a chain. Origin decoding adds one optional label
on the first invocation: where the chain came from.

## How the id gets in

A frontend sends the action id as the `x-b3-traceid` header on its Hasura mutation. With
Hasura's OpenTelemetry config on, that id arrives in the event payload at
`event.trace_context.trace_id`, and the Hasura source puts it on
`envelope.meta.sourceTraceId`.

That id is only for display. It is never the chain's id. Each chain gets its own
correlation id (the id that ties a chain of invocations together) minted fresh at the
start, the same whether or not an id came in. Two reasons:

- Frontends send the same id for the same action every time, which is what makes it worth
  decoding. If that id became the chain id, every unrelated run of the action would
  collapse into one chain.
- A client should not get to pick a chain's id. It can send any id it wants.

## Write your `decode`

You supply a `decode` function. It takes the incoming id and returns an object to show, or
`null` for an id it does not know (then nothing happens). eventkit does not ship a
`decode`, because the meaning of your ids is yours. The plugin will not register without
one.

### The usual way: a list of your actions

Keep a list of the actions your frontends can start, in your own code, shared by the
frontend that sends the id and the function that decodes it. Add to the end. Never reuse
or change an existing id.

```ts
// origin-actions.ts
export const ORIGIN_ACTIONS = [
  { id: 'act-move-create', action: 'move.create', site: 'dealer-portal', purpose: 'dealer creates a move' },
  { id: 'act-driver-assign', action: 'driver.assign', site: 'admin', purpose: 'dispatcher assigns a driver' },
] as const;

const BY_ID = new Map(ORIGIN_ACTIONS.map(a => [a.id, a]));

export const decodeOrigin = (id: string) => BY_ID.get(id) ?? null;
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

What lands at `context_data.origin`:

```json
{ "action": "move.create", "site": "dealer-portal", "purpose": "dealer creates a move" }
```

The list holds the names, so there is no separate name mapping. The ids can be the same
every time an action runs, because they are only for display and the chain id is minted
separately.

### Another way: pack the fields into the id

`decode` can do anything. If you would rather put the fields in the id than keep a list,
unpack them:

```ts
// e.g. "1.7.prod" = version 1, surface 7, env prod
const decode = (id: string) => {
  const m = /^(\d+)\.(\d+)\.(\w+)$/.exec(id);
  if (!m) return null;
  return { idVersion: Number(m[1]), originId: Number(m[2]), env: m[3] };
};
```

The list is the better default, since it keeps the names and meaning in one place.

## What lands where

`decode` returns any JSON object, and it goes on `request.meta.origin`, which observability
writes to `context_data.origin`. Only the first invocation of a chain gets one: later steps
carry a Hasura-generated trace id (a real span id), not your action id, so `decode` returns
null for them. An id you do not recognize, or no id at all, means no origin, and nothing
else changes.

## What the console shows

When the first invocation of a chain has a `context_data.origin`, the flow canvas draws a
node to its left, joined to that invocation. It shows the action, the person who did it
(name and role), and when. That node carries the ORIGIN marker, since the click started the
chain, not the row write. Click it for a drawer with the decoded fields, the full raw
object, and a link to the invocation it started.

Who did it comes from the signed session, so it is real. The console shows a name and
avatar if you give it a resolver: the console config takes an optional `userResolver(email)`
that returns `{ displayName, avatarUrl }` from wherever you keep profiles (a users table, an
identity provider, a static map). Without one, it shows the email and initials. It calls the
resolver once per email and caches the result. The dev harness (`console/src/index.tsx`) has
an example.

### Chains from one click

If the decoded object has a `clickId` (an id the frontend sends that is the same for every
chain one click set off), the console groups them. One action node stands in front of all
the chains that click started, with an edge into each, a small "N chains" count on the card,
and a drawer section listing them so you can jump between them. Chains without a `clickId`
each get their own node. Like everything decoded, the `clickId` is for display grouping
only, and each chain keeps its own correlation id.

## Sending the id from the frontend

Nothing is generated per request. A button carries its action id in a data attribute, and
your Apollo link or fetch wrapper copies it onto `x-b3-traceid`:

```html
<button data-action-id="act-move-create" onclick="createMove()">Create move</button>
```

```ts
const actionId = triggerEl?.dataset.actionId;

client.mutate({
  mutation: CREATE_MOVE,
  variables,
  context: actionId ? { headers: { 'x-b3-traceid': actionId } } : undefined,
});
```

## Options

- `originDecoder({ decode })`: `decode` is required. Your function from the incoming id to
  an object, or null.
- `correlationFromTraceId` on the `hasuraEvent` source, default off. Off keeps the trace id
  out of the chain id (the safe default). Turn it on only for a trusted caller that sends a
  real, unique trace id per request that you want to be the chain id.

## Keep in mind

- The id holds no time and no user. The server's event time is already on the payload and
  rows, and the user arrives signed in `session_variables`.
- A decoded origin is display only, and a client can spoof it. Use it for labels and
  grouping, never as proof and never for an authz check. Anything that has to be trusted
  comes from `session_variables` or the server.
- Sending the same id per action means it cannot double as a real trace id. If you later run
  a tracing backend like Tempo, per-action ids would collapse every trace for that action
  into one. The fix is to send `actionCode` plus a random suffix and match `decode` on the
  prefix. eventkit needs no change for that.
