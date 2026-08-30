# @source-repo/opcua

An OPC UA address space, served as aspects: browsed a branch at a time, with identity that survives a reconnect.

```
npm install @source-repo/opcua
```

- **OPC UA is not an aspect** — it is a source and a protocol, the way Markdown is a format. The address space, the server's own hierarchy, is one *arrangement* of the objects it holds; functional and location are others over the same nodes.
- **Identity is the namespace URI, never the index** — `ns=4;s=Filler01` is a fact about one session's namespace array, and adding a namespace makes yesterday's `4` point at somebody else's nodes. This package hands out `nsu=urn:acme;s=Filler01`, OPC UA's own portable form, and resolves the index per session.
- **A branch at a time** — a real address space is hundreds of thousands of nodes, so nothing walks it to answer a question. `getChildren` and paging come from [`@source-repo/aspects`](./aspects.md) rather than being written here.
- **`hasChildren` is a measured trade** — `browse` costs one extra batched request per expansion and is exact; `node-class` is free and calls every container expandable. The suite counts Browse requests and pins both numbers.
- **Functional and location come from rules the deployment supplies** — as code, never over the wire, because a grouping rule is exactly the kind of structure rule aspects refuses to take from a caller. What crosses the wire is the tree it produced.
- **Selection is part of an arrangement** — a rule that returns nothing leaves a node out, so an operations aspect is four hundred nodes rather than eighteen thousand.
- **Bindings say how a node can be reached** — a Variable is observable, a Method is operable, an Object is neither. A binding describes; it grants nothing.

Derived arrangements need an explicit, bounded `index()`. A browse answers *what is under this node* directly, but knowing what belongs under "Hall 2" means having asked the rule about every node — so that walk is a method somebody calls, with a count and a timestamp in the component's state, rather than something that happens quietly behind the first click. An un-indexed arrangement refuses rather than answering empty: nobody having looked is a different statement from the rule having found nothing.

No subscriptions, no writes, no methods, and no component per node. Two hundred thousand UA nodes are two hundred thousand occurrences behind one provider. **Aspects browse; bindings reach; components live.**

Full documentation: the [package README](https://github.com/source-repo/rpc/blob/main/packages/opcua/README.md), and [the design note](https://github.com/source-repo/rpc/blob/main/notes/opc-ua/opc-ua-as-aspect.md) it was built from. On npm: [@source-repo/opcua](https://www.npmjs.com/package/@source-repo/opcua).
