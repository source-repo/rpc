# The generic viewer, and what a node has to say to get one

*Written before the work rather than after it, which is the opposite of `branches-and-rows.md` and worth saying out loud: that note recorded four decisions that changed shape on contact with a fixture, and it was written by someone who had already met the fixture. This one has not. Treat the order as considered and the details as provisional.*

The reading behind it is in `notes/rpc-admin-capabilities/`, which is an outside evaluation of react-admin and its enterprise modules against this repository. Those are the input; this is the decision.

## What the survey actually found

The interesting result was not a missing architecture. It was that most of what a good generic viewer needs is **already declared, already served, and consumed by nobody**.

`getMany` and `getManyReference` exist for exactly the reason react-admin has them - fifty rows holding a customer id must not become fifty round trips - and both `document` and `relational` serve them. Nothing anywhere says *which field refers to which resource*, so no client can use either. `create`, `update` and `delete` exist with permission rules, column allow-lists and refusals-as-outcomes, and both store packages implement them; the console cannot write a row at all. `getOne` was named in `RpcDataMethod` and served by nothing for months. Row actions were drawn for lists and trees while no aspect provider could declare one.

The pattern repeats: the contract lands, a provider implements it, and the capability stays invisible because the viewer never grew a way to ask. So the first two thirds of this plan is finishing things, not starting them, and the packages the survey proposes are deliberately last.

## Three layers, and the middle one is the new work

```
viewer preferences     chosen columns, widths, order, saved views     the reader's
presentation semantics label, representation, format, sections        the node's advice
resource contract      row type, verbs, references, actions           the node's claim
```

`presentation.defaultColumns` already sits correctly in the middle, and its comment already draws the line the rest of this has to stay behind: which columns come first is the resource's advice, which columns you end up looking at are yours. Nothing here adds widths, colours, component names or layouts to the wire.

The layer split matters more here than it does for an admin framework, because the same declaration is read by a browser, by the CLI and by MCP. This is a **resource semantic model** of which the UI is one consumer, and naming it a UI schema would invite exactly the fields that must never be in it.

## The order

**One - make the generic viewer good.** No new packages, no new verbs.

*Three field sets, of which one existed.* `defaultColumns` answers what a row looks like among its siblings; `detail` answers what it looks like opened on its own; `edit` answers which of the fields a caller may write are worth putting in front of them. Three questions with three different right answers - a serial port has four columns worth scanning, about twelve worth reading when something is wrong with it, and three anybody outside the program would ever set. All three order and promote; none of them conceals, and `edit` can only narrow what `writable()` already permits, because a presentation hint that could make a field editable would be a hint deciding authority.

*Representation.* One field path per resource, validated against `row` the way `defaultColumns` is. A single path rather than a list or a format string: a list is a formatting decision wearing a data hat, and the case for more than one is not yet made by anything real. It is what a confirmation should say instead of an id, what a reference will render as, and what a search hit will be titled - so it comes first because three later things stand on it.

*Mixed kinds in a list.* A scoped OPC UA list is a hundred and forty-nine Variables beside fourteen Methods under one column set, and a folder listing is documents beside folders. The viewer half needs no wire change at all, because rows already carry `kind`: offer the kinds present as a filter. Counts drawn from a page are counts of that page and must be labelled as such - a page-derived number presented as a resource total is the kind of confident wrong number this codebase is otherwise careful about. The contract half is a discriminated union in `row`, which `TypeNode` can already express, and per-kind presentation metadata only if the union genuinely cannot carry it.

*Semantic formats.* `markdown`, `code` with a language, `url`, `duration`, a unit on a number. On `TypeNode`, beside `min`, `max` and `pattern`, because a value's format is a fact about the value rather than about a viewer - but **non-validating**: a format is metadata a renderer may use, never a constraint that can refuse a payload, or the same string starts failing at a peer that understood it yesterday. Settle where the extractor reads it from before adding the field.

**Two - close the loops.**

*References.* `{ field, target }`, where the field holds the target's row id, and nothing more. `targetField` waits until `getMany` can honestly answer for a key that is not the row id - advertising it first would be a declaration no provider can keep. `relational` derives them from foreign keys, which is close to free since it already reads the schema, and only for the keys it can represent truthfully. This is what turns a set of adapters into something navigable, and it is the first thing here that needs conformance: as soon as two providers declare references, `packages/conformance` gains the fixture, because two providers meaning different things by one word is precisely what that package exists to prevent.

*The record editor.* The write contract is complete and unused by any browser. The argument form built for row actions is most of the machinery, and more of the rest exists than this note first claimed: `writable()` already answers with the fields a caller may write, resolved against the store, and MCP already asks it. Discovery is answered too, and by convention rather than by design - MCP's own refusal text says it, *the write half is exposed beside the read half, conventionally as `<read name>.write`*. A convention that two consumers follow is worth writing into the contract before a third invents its own.

*Search, as a client before it is a contract.* Fan out over the resources a peer already declares, matching the declared `representation` field and the id, with small page sizes. Not a generic `contains` across whole rows: an object row does not match a string meaningfully, and asking a SQL node to scan every column of every table is a query nobody sized. Build it over what exists, find out what it needs - ranking, highlights, a real `search` verb for stores that can do better than a filter, a bound on cost - and declare that afterwards. A hit resolves through `RpcRef`, which already exists; inventing a second locator would be inventing a second way to name the same thing. Search conformance waits for the contract, because there is nothing yet to conform to.

**Three - extract and federate.** `@source-repo/react` from `packages/cli/web` once waves one and two have stopped reshaping the components; the components already take explicit props rather than console context, so the move is mechanical when the shapes are settled. Federated search as a package once more than one kind of node can answer. `revisions` and `audit` are two different questions - *what did it look like* and *what happened* - and both stay concepts until a second consumer needs them; neither belongs inside `continuity`, whose job is fenced replacement of running implementations and not every version an object ever had.

## What the first step found

*Appended after representation was built, which is the part of `branches-and-rows.md` worth imitating.*

**One field names a row inside its parent, not inside a scoped list.** Declaring `title` gave the OPC UA address space exactly what it should: an action about `Setpoint` says `Setpoint` rather than `nsu=urn:demo:plant;s=Filler01.Setpoint`. But a list scoped to a line draws from several devices, so `Setpoint` appears twice and names neither row. The instinct is to widen the field to a list of paths; the better reading is that the missing fact is not part of the *name*. It is the `path` the walk already reports and the table already draws as a column, and composing the two is a decision about a screen showing rows from many parents - which is the viewer's to make, not the resource's. That the tension resolved on the viewer side rather than the contract side is the first evidence that the layer split above is drawn in the right place.

**The guess it replaced was wrong in a way nobody had noticed.** `labelOf` tried the declared columns first and then `title`, `name`, `label`, so a scoped OPC UA row was named after its *first column* - which is `path`, so every row in a device was called `Filler01`. It looked right on a document library, where the first column happens to be the title, and it had been wrong on the address space since the day `path` was added in front of it.

## Refused, and why

**No `capabilities: { search?: boolean, revisions?: boolean }` bag.** A resource already says what it can do, in `verbs`, whose rule is that a viewer offers what is there and nothing else. A parallel dictionary of booleans would be a second vocabulary for one question, and the two would disagree the first time somebody added to one of them. Where a capability is a verb it becomes a verb; where it is a fact about the resource it becomes a field.

**No optimistic or undoable mutations, and no `updateMany`.** Delaying a mutation for a few seconds while the screen pretends is good UX for renaming a customer and an awful default for starting a conveyor. The UI derives its behaviour from `query`, `idempotent-command` and `non-repeatable-command` instead, which is a better model than a viewer-side mutation mode and is already on the wire. Fifty changes remain fifty preconditioned, refusable writes.

**No JSON Schema.** `TypeNode` is authoritative, and a second canonical type system would be two things to keep in step.

**No guessers.** A guesser exists because a framework cannot see the backend. `describe()` can, so the viewer is a deterministic renderer of a declaration rather than an inference from sample rows.

**Capability projection is not authorization.** A node may say what a principal will be allowed to attempt, so a screen can stop offering what will be refused - and `authorize()` still rules on every call. A hidden button has never been a security boundary.
