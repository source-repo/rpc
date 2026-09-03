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

*Semantic formats, and the half of them that turned out not to be a format at all.* The plan was `markdown`, `code` with a language, `url`, `duration` and a unit, all on `TypeNode` beside `min`, `max` and `pattern`, with the extraction source to be settled first. Two things came out of looking properly.

**A unit is a fact about the node, not about the field.** An address space has `degC` on a temperature and `rpm` on a speed and nothing on a boolean, and all three are the same `value` field of the same declared row - so a unit on the type could only say something true of every row at once, and there is nothing true of every row. It is a *value*, and it arrives as one: OPC UA reads each Variable's `EngineeringUnits` property, batched, and the row carries `unit` beside `value`. That needed no contract change whatsoever, which is the answer to how much of this the type system should carry.

**And the extractor barely comes into it.** Every provider here writes its `row` as a `TypeNode` literal in source, or builds one at runtime from a schema or a browse; none of them is extracted from a TypeScript interface. So a format on a row field is a key somebody is already typing. The extractor only reaches *method parameters*, where the layering would be: the type says it where a branded alias can, a decorator where it cannot - `@rpc` already carries `semantics`, `effect` and `sets`, and TypeScript cannot decorate an interface field so it is a method-only tool - and JSDoc as the fallback for what neither reaches, an `any` or a dictionary. That is deferred: no method parameter wants a format yet, and the field would be one nobody sets.

So `TypeNode.format` is **not built**. When it is, it must be non-validating - metadata a renderer may use, never a constraint that can refuse a payload, or the same string starts failing at a peer that understood it yesterday.

**Two - close the loops.**

*References.* Built. `{ field, target }`, where the field holds the target's row id, and nothing more - `targetField` waits until `getMany` can honestly answer for a key that is not the row id, and advertising it first would be a declaration no provider could keep. `relational` derives them from foreign keys, which was close to free since it already reads the schema, and publishes only the ones that can keep the promise: not a composite key, not a target this catalogue does not serve, not a key pointing at some column other than the target's id. Each is dropped in silence rather than approximated, because a reference that resolves to nothing is worse for a reader than a plain column of ids.

Two things came out of building it.

**A reference is only as useful as the name at the other end**, so it needed `representation` on the target - and for a SQL table nobody had declared one. The temptation was to guess: the first text column that is not the key is right surprisingly often. It is also wrong exactly where it matters, and a wrong one is not a rendering glitch - it puts the wrong sentence beside a row and beside every reference pointing at it, with nothing to tell a reader it is wrong. So `names` is declared per table by whoever deploys the node, the same way `ids` already is, and a column the table does not have is dropped and said out loud.

**And the check has two halves that fail differently.** A field the row does not have costs what a bad presentation hint costs: nothing is drawn. A *target nobody serves* is worse and gets its own sentence - the row carries the id, the id is right, and a viewer following it asks for a resource that is not there. It is checkable only in `describedResources`, which is the one place every resource of a component is in hand at once.

Conformance followed immediately, and earned itself on the first run. `packages/conformance` now states what a reference *means* - the field holds the target's row id, so `getMany` on the target answers for it - as a checker both suites call against their own data rather than against their own declaration. `document` became the second provider by being *told*: a document store has nothing to derive a relationship from, and the alternative to being told is guessing from a field's name, which is wrong in a way nobody can see.

The first run of it found a real bug on MySQL. The portable route to the referenced side of a key is `referential_constraints` → `unique_constraint_name` → `key_column_usage`, and on MySQL that name is `PRIMARY` for every table with a primary key - so the join matched every table's key at once and the query answered with whichever row came back first. A reference pointing confidently at the wrong table, on one engine of three, from an implementation whose other two engines were correct. MySQL needs its own query against `referenced_table_name`, which Postgres leaves null. That is precisely the drift the package exists to catch, caught the first time all three were asked the same question.

*The record editor.* Built, and it was mostly assembly: `writable()` already answered with the fields a caller may write resolved against the store, MCP already asked it, and discovery was already conventionalised as `<read name>.write`. The argument form from the row actions supplied the rest. `presentation.edit` found its consumer - advice ordering and narrowing what `writable()` permits, never widening it.

The part that is not assembly is the **stamp**, and it turned out to be the whole design. `update` takes the stamp the row was read under and refuses if the row has moved, which makes two people editing one row a visible outcome instead of a lost update - so the editor reads through the write surface's own `getOne` rather than reusing the copy the table beside it already has, because a stamp from a different question is a precondition that has stopped meaning anything.

A conflict comes back carrying no stamp, deliberately, and the editor must not paper over that. It took two goes to get right. The first version kept what somebody had typed when they asked to read the row again - kind, and wrong: it showed them their own value with no sign of the one they were about to overwrite, which is the blind overwrite the missing stamp exists to prevent, arriving by a different route. Re-reading now remounts the form on what is there now. Losing the typed text is the point.

And one thing fell out of drawing a SQL row at all: the type language has **two spellings of null** - the extractor writes an optional parameter as a union with a null *literal*, a provider building a type at runtime writes `{ kind: 'null' }` - and the console knew only the first. Not a near miss: a union whose null goes unrecognised falls through every widget to the JSON textarea, so every nullable column of every table was a box of JSON where a text box belonged.

*Search, as a client before it is a contract.* Built, exactly as a client: one box asks every resource of a peer that answers `getList` and declares a `representation`, one `contains` clause against that field, five rows each. Nothing new on the wire. Typing `er` into the devserver returns OPC UA nodes, two derived arrangements of them and a SQL customer, side by side, from three providers that share no code. A hit is an address the console already reads - `?observe=&ns=&scope=` - which lands the reader on the component *and* the resource it was found in.

What it cannot do is the specification for what a real search contract would have to add, and this is why it was built this way round:

- **A resource that only answers `getChildren` cannot be searched at all.** The whole document library is absent from the results, because a tree browsed a branch at a time has no way to be asked a question about all of it. That is the largest single finding: search needs either `leaves` on every aspect provider that wants to be found in, or a verb of its own.
- **There is no ranking, and nothing here could invent one.** Results are grouped by where they came from, in the order the peer describes them, because a client cannot say whether a customer or an OPC UA node is the better answer to `er`. A real search must, and that is a judgement only a node can make about its own rows.
- **It finds things by name and by nothing else.** The representation is the one field a resource nominated; a row whose *contents* match is not found. Highlights have nowhere to come from either.
- **The cost bound is a guess.** Five rows per resource on a settled keystroke is a number chosen because it felt affordable, not one any node was asked about.

Search conformance still waits for the contract, because there is still nothing to conform to.

**And then it was federated**, which is `@source-repo/search`: the fan-out, the bound, the merge and the refusals, with the console reduced to drawing what comes back. A hit is a locator - peer, namespace, resource, id - so a browser resolves it to a page, the CLI prints it and MCP follows it, and no consumer's answer is imposed on the others. Two things it settles rather than defers. The ordering is `MatchQuality`, not a score: how well a *name* matched what was typed is a fact about two strings, and saying that plainly is the only honest thing a client can say when no node ranks its own rows. And a target that fails is a refusal carried beside the results, because one machine rebooting is the ordinary state of any network worth searching and a search that threw would answer nothing at all because of it.

The fifth finding arrived immediately, and it was the one that stopped the feature being usable: **`contains` is case-sensitive, deliberately.** The conformance fixture keeps `borg` and `Borg AB` distinct on purpose and the SQL flavours go to some trouble to force binary collation across three engines, because a *filter* that folded case would silently change what a query means. A *search box* has the opposite requirement: somebody typing `acme` means `Acme Ltd`, and the box answered *nothing of that name*.

So the clause gained `fold`, and the shape of the fix is the finding. **A flag on the condition, not a second set of operators**: `containsFold` beside `contains` would double the operator table for one axis and leave every future one to double it again, and it would let a resource declare an operator a backend has no way to mean. And it is **refused where it would mean nothing** rather than ignored there - `fold` on `lt` is not a case-insensitive comparison, it is a collation, which is a property of a column and not of a question, so asking for it is an error with that sentence in it. Both halves matter: an ignored flag is how a caller comes to believe a query means something it does not.

What it cost was four implementations and a question. `lower()` on both sides in SQLite and Postgres; in MySQL, *dropping* the binary casts that the case-sensitive path adds, which is the one place the folded path is simpler than the strict one. `$options: 'i'` in Mongo, with the operand still escaped. And the conformance suite asks both spellings of it across all four backends, because "they all fold" is exactly the kind of claim that is true of three engines and quietly false of the fourth. The SQLite fold is ASCII-only without ICU, which is stated where it is done rather than discovered later. Searching then asks for it unconditionally - not configurably, because folding is a property of *searching* rather than of any particular query.

**Three - extract and federate.** `@source-repo/react` is extracted, and the claim that it would be mechanical held: the components already took explicit props rather than console context, so the cut was a closed set - the rules, then the components that use them, and nothing reaching back into the console. What stayed behind is the application: the peer view, the panels, the chat, and `ComponentPanel`, which assembles the toolkit and pulls in `@source-repo/diagnostics` - a package that versions *with* the library, and would have dragged this one into that rule.

Three things the move itself taught, none of them about React. Explicit `.js` on every relative import, because a package that must load under Node is not a directory a bundler resolves. A `customConditions` of `browser`, because the library publishes a browser entry and the page-visibility signal a watched collection uses only exists there. And the tests need their own project against the *Node* entry, because one of them stands up a real server - which the console had already discovered and solved the same way.

Styles came with it on a second pass, and splitting them turned out to be the same split the contract makes one layer up. The package says what a table row, a chip, a form and a tree node *are*; the console says where they sit - so every rule beginning `.app.observing` stayed behind, because arranging three panes on a page is the application's business and a consumer arranging them differently should not have to fight a stylesheet that assumed otherwise.

Two things made it a package rather than a copy of the console's file. Every colour is a token *with a fallback* - `var(--line, #262e3a)` - so defining the tokens takes your palette and defining nothing looks like the console it came from; a `:root` block shipped from the package would have depended on stylesheet order instead. And the buttons carry their own `background`, `border` and `cursor`, which they had been inheriting from a global `button` reset: a package that needs its consumer to have written a reset looks broken for a reason nothing on the page explains.

What this wave still leaves alone: `revisions` and `audit` are two different questions - *what did it look like* and *what happened* - and both stay concepts until a second consumer needs them. Neither belongs inside `continuity`, whose job is fenced replacement of running implementations and not every version an object ever had.

**Four - the reader composes the screen.** Everything up to here shows one scope, of one component, of one peer, and every navigation replaces the last - which is right for reading a node and wrong for watching a plant, where the four things somebody is comparing sit on four machines. A **watch list** is an ordered set of chosen nodes, each a locator, added from wherever the reader happens to be and kept until they take it out.

The split follows the one `@source-repo/search` already made. The **model** is in `@source-repo/react` - what a chosen node is, how a set of them groups into subscriptions, what a stored one reads back as, and what the whole network reads as - because a CLI or an MCP server would otherwise write it again. The **arrangement** is in the console, because it is a layout and the toolkit says plainly that it does not do layout. `watchParts.ts` holds the links, exactly as the host supplies `Search` with its `ask`.

*A watch list holds whatever the console can show, not only what it can subscribe to.* The first cut drew value rows itself and so could hold typed state and nothing else. It was enforcing a real rule - a collection is paged rather than watched - but that rule is about the *projection*, and it had been quietly promoted into a claim about what a section may contain. The rig found it immediately: on this network every interesting node is an aspect provider, a document library or a relational service, so a values-only list could hold nothing at all, and the plant tree the whole idea started from was the first thing excluded. The fix deleted code rather than adding it - each section is a `ValueGrid` for the chosen scope, so a list now holds an OPC UA address space, a SQL table and a document folder side by side, from three peers, because the grid already knew how to draw all three.

### The argument about the whole network, which was wrong

The first version of this note also rejected a **root above the network** - every scope of every peer, in one list - on the grounds that a federation is thousands of values and a screen showing all of them shows none. That did not survive being questioned, and the way it failed is worth keeping.

It is an argument about *size*, and size is not something the network root introduces. One OPC UA address space on the rig is four hundred nodes and a real one is far larger; the console already deals with that, because the scope tree is bounded by the contract, collections are paged and trees are browsed a branch at a time. So *where is the limit for one large node* has the same answer as *where is the limit for the whole network*, and refusing the second while shipping the first was avoiding a confrontation rather than settling one. The person who pointed this out did it by opening the nodes one after another in fifteen seconds and observing that nothing exploded, which is the correct kind of evidence.

What genuinely did not scale was never the number of nodes. It was **holding a channel per section** - and that is a defect wherever it happens, including in a hand-picked list of thirty, so it wanted fixing rather than dodging. A closed section now costs nothing: no grid, no channel, no question. The list becomes headings, which are free, and opening one costs exactly what opening that node has always cost. With that in place the derived list is not a special case needing a special argument; it is the same pane over a different set, and `everything` sits beside `chosen` as a switch.

What the whole network does still cost is one `describe` per peer, which is irreducible - a console cannot list what a peer serves without asking it - and is now bounded rather than issued as a burst. The bound is `@source-repo/search`'s own `throttled`, exported for the purpose: asking every peer *what do you serve* has the same shape as asking every peer *do you have a row*, and a console that bounded the second while sending the first as a burst would have solved half a problem.

Two smaller things fall out. Sections a reader *added* start open, because choosing one is the act of saying you want to watch it, while derived ones start closed - a rule about how the node got into the list rather than a threshold on how many is too many. And a derived section carries `keep`, which pins it into the chosen list, so browsing everything is how a watch list gets built.

### Grouping by peer, which turns the last cost into nothing

The flat `everything` still had one: a peer serving forty resources is forty headings, and worse, a flat list has to **describe every peer to know what to put in it** - so it spent a round trip per machine on a pane somebody may have opened to look at one of them. Grouping by peer fixes both, and the second is the one that matters.

The list is now built from the *peers*, whose names the console already knows from the network, and a peer is described when somebody opens it. Which gives a cost ladder that can be stated in one line and was measured over the wire rather than asserted: **opening the pane costs nothing** - zero describes, four peer headings; **opening a peer costs one describe** - nine scope headings, still no channel; **opening a scope costs one channel**. Collapsing a peer releases its channels and remembers the expansion, so re-opening it re-asks nothing and brings back what was open.

Building the outer level from the peer list rather than from the descriptions has a second effect worth having: a peer that is unreachable or has not been asked is *in the list*, saying so, where a list derived from descriptions would leave it out and let a reader see a shorter network instead of a broken one.

It also exposed an inconsistency in `chosen`, which had been describing the peers of every node it held whether or not the section was open. The rule is now the same in both modes - describe what is open - which mostly changes nothing there, because a node somebody added starts open, but a collapsed section should no more cost a description than it costs a channel.

`chosen` is deliberately **not** grouped. It is in the reader's order because they put it in one, and grouping it by peer would re-sort it - which is exactly what somebody comparing the same line on two machines does not want. `everything` is derived and has no order to destroy.

Read-only for now, and deliberately: the machinery that makes commanding safe - the argument form, the write discovery, the conflict re-read - belongs to `ComponentPanel` and to *a* component, and `open` on any section is one click to the page where all of it is. Commanding a plant from a screen assembled out of four peers is a thing to design on purpose rather than to inherit by passing one more prop.

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
