# @source-repo/aspects

Several structures over the same objects, and links that keep their context.

```
npm install @source-repo/aspects
```

## The idea, and whose it is

IEC 81346 says an object is viewed in several **aspects**, and that an aspect is a way of looking rather than a place the object lives:

| Aspect | Prefix | The question it answers |
|---|---|---|
| Function | `=` | what it does — the loop it serves |
| Product | `-` | what it is part of — the assembly it belongs to |
| Location | `+` | where it stands — the room, the cabinet |
| Type | `%` | what kind of thing it is — the model it is an instance of |

The **type** aspect arrived with the 2022 edition, and it is the one worth pausing on, because it is not a structure over individuals at all: it places an object under the *class* it belongs to. This pump, and every other pump of that model, sit under one type — so what is said once about the type is true of all of them, and what is said about the pump is true of that pump. A system that has no type aspect ends up saying the model's things about each instance, and then disagreeing with itself.

A pump therefore appears under the loop it serves, the assembly it is part of, the room it stands in, and the model it is an instance of. It is one pump.

## Saying which aspect you mean

An aspect's `id` is a local name. Two providers written by different people may each offer a `functional` aspect and mean the same thing, or not, and nothing in the name says which — fine for a console drawing a tree, useless for anything that has to line two providers up: an OPC UA bridge, an import, an assessment, an MCP client reasoning across peers.

So a descriptor may *also* say what it is in somebody else's vocabulary:

```ts
{ id: 'functional', label: 'By loop', revision: '3', semantics: IEC81346.function }
```

`semantics` is `{ scheme, term }` — two fields rather than one URI, so a consumer switches on the scheme without a parser and without a convention nobody enforces. `IEC81346.function`, `.product`, `.location` and `.type` ship as constants because typos are the failure mode, not because an aspect has to be one of them. **No scheme is privileged and nothing is required.**

Absent is the ordinary case and says something true: this is a structure this provider offers, and no claim is made that it is anybody else's. `@source-repo/documentation` claims nothing for either of its arrangements, because filing by folder is not IEC's function aspect and borrowing the nearest word would make a consumer believe two providers agreed when one of them had only reused a string. `sameAspectSemantics` treats unclaimed as equal to nothing, including to another unclaimed one — saying nothing is not a claim to agree.

One claim per aspect, not a list: a descriptor asserting three conventional identities is stating a mapping between vocabularies, and a mapping belongs where mappings are curated and versioned rather than scattered across every provider with an opinion.

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

So a link stores what it wants — *the aspect I am in, near where I am* — and is re-resolved every time. A reader browsing the security aspect who follows a link lands on the target **in the security aspect**, because the aspect is why they are reading; dropping them into the folder tree is not a smaller answer, it is a different subject. When the wanted aspect cannot place the target, the result **says a fallback was used**, so a viewer can tell the reader rather than quietly changing the subject.

Falling back means the provider's default aspect — but only when that aspect can actually place the target. When nothing places it, the answer names no aspect at all and the object stands on its own, because naming a structure with no occurrence in it reads as *show this in that tree* and there is nothing in that tree to show: a viewer would draw an empty structure, or highlight nothing in a full one, and either way say the object is somewhere it is not.

A link may also insist rather than accept any of that: `fallback: 'refuse'`.

## What it deliberately is not

Not a store, not a parser, not a renderer. Not a query engine either: no expression language reaches a provider from the network — a caller names an aspect and a parent, and the provider's own code decides what that means.

The content vocabulary is three blocks — `markdown`, `code`, `attachment`. An artefact block naming a renderer and a live-example naming a method to run are both in the design and neither is here: nothing serves one yet, and shipping words nobody says is how a small contract becomes a large one without anyone deciding to make it large.

MIT.
