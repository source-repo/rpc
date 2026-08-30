# @source-repo/aspects

Several structures over the same objects, and links that keep their context.

```
npm install @source-repo/aspects
```

- **IEC 81346's idea, and its word** — an object is viewed in several *aspects*: function (`=`), product (`-`), location (`+`), and since the 2022 edition type (`%`). An aspect is a way of looking, not a place the object lives. A pump appears under the loop it serves, the room it stands in, the assembly it is part of, and the model it is an instance of. It is one pump.
- **Structure is an aspect; identity is not** — `AspectRef` says which object, an occurrence says where it is showing. Confusing the two is how a system ends up with the same thing twice, each copy accumulating its own comments.
- **A provider writes the middle** — which aspects exist, what is under a node, where an object appears, how to open one. Each aspect is then published as a `shape: 'tree'` resource, served a branch at a time, with `hasChildren` and link resolution supplied.
- **Links carry intent, never a path** — a path is a fact about a tree at a moment. A link stores *the aspect I am in, near where I am* and is resolved against the structure as it is now.
- **A change of subject is reported** — when the wanted aspect cannot place the target, the answer says a fallback was used. A link may also refuse rather than accept one.
- **Not a store, a parser, a renderer or a query engine** — no expression language reaches a provider from the network: a caller names an aspect and a parent, and the provider's own code decides what that means.

Aspects are deliberately *not* Source RPC's [topology](../guide/topology.md). Physical `parent` and logical `owner` participate in fencing and inherited context; an aspect is a read model, so appearing under an authorised-looking branch grants nothing and a security aspect describes zones rather than deciding them.

Full documentation: the [package README](https://github.com/source-repo/rpc/blob/main/packages/aspects/README.md). On npm: [@source-repo/aspects](https://www.npmjs.com/package/@source-repo/aspects).
