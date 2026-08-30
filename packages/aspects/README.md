# @source-repo/aspects

Several structures over the same objects, and links that keep their context.

```
npm install @source-repo/aspects
```

## The idea, and whose it is

IEC 81346 says a plant object is viewed in several **aspects** — functional (what it does), product (what it is), location (where it stands) — and that an aspect is a way of looking rather than a place the object lives. A pump appears under the loop it serves, under the room it stands in, and under the manual that describes it. It is one pump.

This package is that idea over Source RPC, generalised past the three: a security aspect, a documentation aspect, a work-breakdown aspect are all the same shape. **Structure is an aspect, identity is not.**

Source RPC already has two structures with runtime meaning — physical `parent` and logical `owner` — and those participate in fencing and inherited context. Aspects are deliberately *not* those. An aspect is a read model: appearing under an authorised-looking branch grants nothing, and a security aspect describes zones rather than deciding them.

## What a provider writes

```ts
class Plant extends AspectProvider<Props, State> {
    aspects() { return [{ id: 'functional', label: 'By loop', revision: '1', default: true }, …] }
    children(aspectId, parent, page) { … }   // what is under a node
    placements(target, aspectId) { … }       // where an object appears
    open(target) { … }                       // one object, with its content
}
```

What it gets without writing it: each aspect published as a `shape: 'tree'` resource, branches served a page at a time over `getChildren`, `hasChildren` filled in from the occurrences, and `follow()` resolving links against the structure as it is now.

That division is the point. Serving a tree over `$data` correctly — the verb, the bounds, the positional flags, the epoch and revision — is the same work every time and easy to get subtly wrong. Deciding what belongs under a node is different for every source and cannot be shared.

## Links carry intent, never a path

A path is a fact about a tree at a moment. Structures get rebuilt and objects get refiled, and a saved path then points somewhere plausible and wrong.

So a link stores what it wants — *the aspect I am in, near where I am* — and is re-resolved every time. A reader browsing the security aspect who follows a link lands on the target **in the security aspect**, because the aspect is why they are reading; dropping them into the folder tree is not a smaller answer, it is a different subject. When the wanted aspect cannot place the target, the result **says a fallback was used**, so a viewer can tell the reader rather than quietly changing the subject. A link may also insist: `fallback: 'refuse'`.

## What it deliberately is not

Not a store, not a parser, not a renderer. Not a query engine either: no expression language reaches a provider from the network — a caller names an aspect and a parent, and the provider's own code decides what that means.

The content vocabulary is three blocks — `markdown`, `code`, `attachment`. An artefact block naming a renderer and a live-example naming a method to run are both in the design and neither is here: nothing serves one yet, and shipping words nobody says is how a small contract becomes a large one without anyone deciding to make it large.

MIT.
