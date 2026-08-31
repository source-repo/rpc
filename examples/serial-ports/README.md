# A rack of serial ports

A node to point `source-rpc console` at, and the case a tree of everything serves badly. It exists because the console's other tree — a document library — wants the opposite arrangement, and one of them has to be wrong about what a child-node view should look like.

## Running it

```sh
npm run build                                    # once, from the repo root
npm run example:serial-ports:contract            # extract -> contract.json
npm run example:serial-ports:build               # strip   -> dist/plant.ts
node examples/serial-ports/dist/plant.ts         # the rack, on :7845
source-rpc console --hub http://localhost:7845   # the console, on :7844
```

Then open the console, select **edge-gw-1**, press **observe** on the component and expand *Cabinet A → USB hub 1*. Click a port.

`HUB=http://localhost:3992 node examples/serial-ports/dist/plant.ts` joins an existing network instead of listening on a port of its own, which is how to put this rack in a console that is already showing something else.

## What is worth looking at

**It is an ordinary component, not an aspect provider.** That is the whole point. `@source-repo/aspects` gives a node a structure and a detail view together, and for a while that was the only way to have either — so a rack of serial ports had to pretend to be a structure of a plant to get a panel that shows one port. It does not any more: this is an `RpcComponent` with one data resource answering `getChildren` and `getOne`, and nothing else.

**The branches are scope; the leaves are a comparison.** Nobody compares two cabinets, they pick one. The ports under a hub are the opposite — the same five fields as each other, and reading the error count *down* the column is the entire job. A handbook is the other way round: its leaf *is* its content, its siblings have nothing worth aligning, and a table of titles would be four columns of noise. Same verb, same console, opposite priorities.

**One row type, two answers.** `row` describes every row the resource hands out — cabinets, hubs and ports alike — so the fields only a port has are optional, and so are the fifteen that only `getOne` populates. A list says what a port looks like among its siblings; `getOne` says what it looks like on its own, which here is twenty-two fields no table has room for. Both are governed by the one declared type a caller can read.

**`description` is in the row type and not in `defaultColumns`.** That is the distinction the hint exists to make: it is a sentence, and a sentence in a column pushes four useful numbers off the screen. Every field stays selectable — this decides what is shown first, never what may be shown.

**`getOne` answers for every id, branches included.** A resource that declared the verb and then refused half the ids it gave out would be worse than one that never declared it: nothing in a row says whether it can be opened, so a viewer can only find out by trying, and finding out means an operator clicking a row that does nothing. Opening a hub gives its location, its port count and how many are faulted.

**An id that reaches nothing answers an absent row rather than an error.** A port can go between the branch that named it and the click that opened it, and that race is not a fault in this node.

**The fault drifts.** One port is faulted and its error count climbs every three seconds, so a detail view left open proves it is *watched* rather than fetched once — which is the difference that matters, since a port's error count is exactly the field that changes while somebody is looking at it.

**The row type is written out rather than derived.** Props and state are read from their declarations by `extract`, because they are the component's own shape and known at compile time. A resource's rows may come from a database whose columns are known only when the node connects to it, so `row` is a runtime declaration. This example happens to know both and says so twice, which is why it runs with `validateResults` on: that is what catches the two disagreeing.

**The actions are the component's own methods.** `resetPort` and `closePort` are ordinary `@rpc` methods — already in `describe()`, already ruled on by `authorize()` and the owner fence, already carrying idempotency. The resource's `actions` list adds no capability at all; it carries the one fact a viewer cannot work out for itself, which is *which* existing method belongs to *which* row.
