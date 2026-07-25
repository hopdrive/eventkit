# Console: expected-flow overlay

The flow canvas can overlay what a run was *supposed* to do on top of what it
*did* do. This is a lens for reading a chain, not a health check. The console
stays generic: it never knows where expected flows come from. The host wrapper
injects a resolver, the same way it injects `userResolver` for origin identities.

There are two parts: the per-invocation canvas overlay, and an "Expected events"
section in the user-action drawer.

## The resolver

Add `expectedFlowResolver` to the config you pass to `<EventKitConsole>`:

```ts
const config: EventKitConsoleConfig = {
  graphqlEndpoint,
  expectedFlowResolver: async ({ sourceFunction, at }) => {
    // Return the expected flow for this function, or null if you don't have one.
    return await loadFlowFor(sourceFunction);
  },
};
```

- It is called lazily, once per distinct `sourceFunction`, and the result is
  cached for the life of the page.
- `at` is the invocation's start time (ISO). It is passed so a future host can
  return the flow that was current when the run happened. Today's hosts can
  ignore it.
- Return `null` (or leave the resolver off) and that invocation renders exactly
  as it does today. Absence of a flow is never treated as a problem.
- Errors are caught and treated as `null`, so a flaky resolver never breaks the
  canvas.

Where the flows actually come from is your choice: a committed `*.flow.yaml`, a
generated registry, a static map. The console doesn't care.

## The contract: `ExpectedFlowGraph`

The resolver returns an `ExpectedFlowGraph`. This is `@hopdrive/eventkit`'s
`toFlowGraph()` output exactly (the `FlowNode` / `FlowEdge` vocabulary), plus a
little optional metadata. A producer can call `toFlowGraph(kit)`, attach the
metadata, and hand the result straight back as plain JSON. There are no
console-specific fields.

```ts
interface ExpectedFlowNode {
  id: string; // name-derived, see below
  kind: 'source' | 'invocation' | 'event' | 'handler' | 'job' | 'sideEffect' | 'terminal';
  eventName?: string;
  jobName?: string;
  sourceFunction?: string;
  required?: boolean;
  condition?: string;
  metadata?: Record<string, unknown>;
}

interface ExpectedFlowEdge {
  from: string;
  to: string;
  required?: boolean;
  condition?: string;
}

interface ExpectedFlowGraph {
  nodes: ExpectedFlowNode[];
  edges: ExpectedFlowEdge[];
  title?: string;       // human label
  generatedAt?: string; // ISO, when the producer generated it
  hash?: string;        // opaque, for cache-busting
}
```

The overlay reads only `nodes` and `edges`. The metadata is display sugar.

### Node ids are the linchpin

Observed records and expected nodes line up by id, and ids are derived from
event and job **names**, never file paths (paths move in refactors). Every
producer must build them the same way:

```
source                              # the one source node
event:<eventName>                   # e.g. event:move.create.requested
job:<eventName>:<jobName>           # e.g. job:move.create.requested:requestVehicleMove
sideEffect:<jobName>:<effect>       # from job metadata
```

`toFlowGraph()` already does this. If you build the graph some other way, match
these ids or the overlay won't line up.

## What the overlay shows

Turn it on with the "Expected flow" toggle in the canvas toolbar, or the `X`
hotkey. The choice is remembered in localStorage. The toggle only appears when a
resolver is configured.

It works per invocation. Each invocation's `source_function` resolves to its own
expected graph, which is compared against that invocation's own observed records:

- **Expected but not observed** steps render as ghost nodes: dashed, muted, the
  same shape and size as the real nodes, attached under the invocation. The
  tooltip reads "expected by the flow definition, not observed".
- **Observed but not expected** steps keep their normal node and get a small
  `off-contract` badge. No new node appears.
- **Matched** steps render unchanged.

It is display only. It adds ghost nodes and a badge; it never removes, hides, or
restyles an observed node, and it is never a pass/fail gate.

This overlay is separate from the older doc-picker overlays ("Show expected",
"Flag off-contract"), which compare the whole canvas against one manually chosen
flow doc. The resolver overlay is automatic and per-invocation.

## Expected events in the user-action drawer

A decoded origin (`context_data.origin`) may carry `expectedEvents`: a list of
event names the cause expects to happen somewhere in the chain. When present, the
user-action drawer shows an "Expected events" section. Each name gets a check if
that event was observed anywhere in the loaded chain, or a muted dashed marker if
it was not.

These are just strings from the decoded origin compared against observed event
names. Like everything else decoded from the client origin, they are context,
not authenticated fact. The origin card itself is unchanged, so it stays
glanceable.
