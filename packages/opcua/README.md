# @source-repo/opcua

An OPC UA address space, served as an aspect: browsed a branch at a time, with identity that survives a reconnect.

```
npm install @source-repo/opcua
```

```ts
const plant = new OpcUaAspectProvider({ endpointUrl: 'opc.tcp://plc:4840', identity: { peer: 'edge', instance: 'plant' } })
await plant.connect()
server.exposeClassInstance(plant, 'plant')
```

## OPC UA is not an aspect

It is a source and a protocol, the way Markdown is a format. What *is* an aspect is an arrangement of the objects a server holds — and the **address space**, the server's own hierarchy, is the first and most obvious one. Functional, location and engineering arrangements over the same nodes are further aspects; none of them is where a node lives.

That is the same conclusion `@source-repo/documentation` was renamed for, reached from the other end.

## Identity is the namespace URI, never the index

A UA node is addressed as `ns=4;s=Filler01`, and that `4` is a **NamespaceIndex** — a per-session compression of a namespace URI, taken from the server's namespace array at the moment you looked. The standard says a client must not assume it is stable between sessions: add a namespace and yesterday's `4` is today's `5`, pointing at somebody else's nodes.

So what this package hands out is `nsu=urn:acme:filler;s=Filler01` — OPC UA's own ExpandedNodeId form, portable by construction. The index is resolved per session, on the way in and out, and never stored. A browse path is then exactly what `@source-repo/aspects` already says a structural path is: a placement, not an identity.

There is a test for the awkward half of that: the same portable id resolving to `ns=2` against one namespace array and `ns=3` against another, and to *nothing* against a server that has dropped the namespace — rather than to whatever now sits at that index.

## `hasChildren`, and what it costs

A viewer needs to know whether to draw an expander *before* anyone expands, and OPC UA can only answer by browsing. Two probes, because the trade is real:

| `childrenProbe` | Cost per expansion | Accuracy |
|---|---|---|
| `browse` (default) | one extra Browse, batched over every child at once | exact |
| `node-class` | none | a container is expandable, a Variable is not — wrong for a Variable carrying properties |

Both are measured rather than asserted: the suite counts Browse requests and pins the numbers, so a change that quietly makes the tree chattier fails.

## Functional and location, which the server does not publish

A generic UA server has a browse tree somebody built and nothing that says what a node *does* or where it *stands*. So those arrangements come from a rule the deployment supplies, as code:

```ts
const byLocation: DerivedAspect = {
    id: 'location',
    label: 'By location',
    semantics: IEC81346.location,
    groups: (node) => (node.path.length ? [['Hall 2', node.path[0]]] : undefined)
}
```

A rule that returns nothing leaves that node out of the arrangement, and **that is the point rather than a gap**: an operations aspect holds the four hundred nodes an operator cares about, not the eighteen thousand the server has. A rule may also return several paths, because a thing genuinely can be in two places in one arrangement.

The rule is code and never travels: `@source-repo/aspects` refuses to evaluate structure rules arriving from the network, precisely so a provider cannot be turned into a query engine by a caller. What crosses the wire is the tree it produced.

**These need an index and the address space does not.** A browse answers *what is under this node* directly; knowing what belongs under "Hall 2" means having asked the rule about every node, which is a walk of the server. So `index()` is explicit, bounded by `maxIndexNodes` and `maxIndexDepth`, and leaves a count and a timestamp in the component's state. An arrangement nobody has indexed refuses rather than answering empty — nobody having looked is a different statement from the rule having found nothing.

Worth keeping straight: **selection as meaning** — "these are the objects that matter operationally" — is an aspect. Selection as configuration — "these are the nodes currently published to MQTT" — is a read model of somebody's settings, and belongs in an aspect only if a person would browse it as one. Without that line, aspects become a tagging mechanism.

## What is deliberately not here

No subscriptions, no writes, no methods, and no component per node. Two hundred thousand UA nodes are two hundred thousand *occurrences* behind one provider; promoting the operationally interesting few to real Source RPC components is a separate decision worth making on its own terms. An occurrence carries what a browse returned — a UA subscription is a different thing with a different lifetime, and pushing change notification into a read model would drag it somewhere it does not belong.

**Aspects browse; bindings will reach; components live.**

The reasoning behind all of it is in [the design note](https://github.com/source-repo/rpc/blob/main/notes/opc-ua/opc-ua-as-aspect.md).

MIT.
