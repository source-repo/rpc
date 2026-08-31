# @source-repo/aspects

Several structures over the same objects, and links that keep their context.

```
npm install @source-repo/aspects
```

- **IEC 81346's idea, and its word** — an object is viewed in several *aspects*: function (`=`), product (`-`), location (`+`), and since the 2022 edition type (`%`). An aspect is a way of looking, not a place the object lives. A pump appears under the loop it serves, the room it stands in, the assembly it is part of, and the model it is an instance of. It is one pump.
- **Structure is an aspect; identity is not** — `AspectRef` says which object, an occurrence says where it is showing. Confusing the two is how a system ends up with the same thing twice, each copy accumulating its own comments.
- **A provider writes the middle** — which aspects exist, what is under a node, where an object appears, how to open one. Each aspect is then published as a `shape: 'tree'` resource, served a branch at a time, with `hasChildren` and link resolution supplied.
- **An aspect may say which aspect it is** — an `id` is a local name; optional `semantics: { scheme, term }` says what it is in a shared vocabulary, so two providers agreeing can be told from two providers reusing a word. `IEC81346.function`/`.product`/`.location`/`.type` ship as constants, no scheme is privileged, and claiming nothing is the ordinary and honest case.
- **Links carry intent, never a path** — a path is a fact about a tree at a moment. A link stores *the aspect I am in, near where I am* and is resolved against the structure as it is now.
- **A change of subject is reported** — when the wanted aspect cannot place the target, the answer says a fallback was used, so a viewer can tell the reader rather than quietly moving them. If no aspect places it at all, the answer names none: an object standing on its own is true, where naming an empty structure would read as *show this in that tree* and there would be nothing in that tree to show. A link may also refuse rather than accept any of it.
- **Bindings say how a thing can be reached** — a different question from where it appears. One object may be reachable over OPC UA, over Sparkplug and as a Source RPC component at once, and none of those is a structure. `role` reuses the library's own `RpcEffect`, so a binding is described in the words authorization is already written in — and a binding **describes rather than grants**: `authorize()` decides exactly what it would have decided without it.
- **A binding may be navigated, and nothing more** — the console draws an `http(s)` endpoint as a link that opens in a tab of its own, and leaves every other scheme as text. That is the browser making a request as itself, against an origin that is not the console's; the console still does not fetch a binding, embed one, or send anything to one. The scheme is *parsed* rather than matched, because `java\nscript:` and `  javascript:` both read as `javascript:` to a URL parser and as something harmless to a prefix test — and an `href` is the one field where publishing a string is publishing behaviour. See [ways in](https://github.com/source-repo/rpc/blob/main/notes/ways-in.md) for the grades beyond this one and why they need more than code.
- **Not a store, a parser, a renderer or a query engine** — no expression language reaches a provider from the network: a caller names an aspect and a parent, and the provider's own code decides what that means.

Aspects are deliberately *not* Source RPC's [topology](../guide/topology.md). Physical `parent` and logical `owner` participate in fencing and inherited context; an aspect is a read model, so appearing under an authorised-looking branch grants nothing and a security aspect describes zones rather than deciding them.

Full documentation: the [package README](https://github.com/source-repo/rpc/blob/main/packages/aspects/README.md). On npm: [@source-repo/aspects](https://www.npmjs.com/package/@source-repo/aspects).
