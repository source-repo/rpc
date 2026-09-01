# Branches and rows

*Written against `1612833`, after the work it describes was built. The plan came first and four of its decisions changed shape on contact with the fixture — those changes are marked, because the shape they arrived at is the useful part and the reasoning that produced the wrong shape is the part worth not repeating.*

## The question

The console had one tree to look at, and it was a document library: a handbook whose leaf *is* its content, whose siblings have nothing worth aligning, and for which a table of titles would be four columns of noise. Everything the tree view did well, it did well for that.

So: how general is that view? And how much of it should the node decide?

## What was already there

Read out of the source rather than remembered, because three of these had been true long enough to be invisible.

`RpcDataAction` already existed on every data resource — a method name, a label, and `confirm`. The grid rendered it for a flat list. The tree half rendered nothing, so nobody declared actions on a tree, so nothing appeared to be missing.

Tree rows already carried the resource's columns, but inline as `name value` pairs beside the label, so nothing aligned down the page.

The detail panel was reached only through `openObject`, an **aspects** verb. The handbook had a good one because it is an aspect provider; an ordinary component with a data resource had no way to open a row at all. That was the generality gap, and it is the one that mattered.

And `getOne` had been named in `RpcDataMethod` since resources were added, served by nothing, refused by the console's own allow-list — the same seam `shape: 'tree'` had before `getChildren` answered it.

## What was built

**`getOne` is served**, for declared resources and for a component's own record alike. It is not `getMany` with one id: a list says what a row looks like *among its siblings*, and this says what it looks like *on its own*, which for a serial port is twenty-two fields no table has room for. One declared `row` governs both, so a resource whose detail is richer declares the extra fields optional and does not populate them in a list. An id that reaches nothing answers with `data` absent rather than an error, because a row can go between the list that named it and the click that opened it.

**The scope pane is a selector when it has no depth.** `props` and `state` are a real hierarchy; a provider whose scope is the list of resources it serves gets roots with no children, and a tree of those is a flat list wearing a tree's clothes while holding a whole column to do it. Derived, not declared.

**A tree resource can be read two ways.** *Structure* is the hierarchy with its leaves in place. *Values* draws the branches as scope and one branch's children as an aligned table. The node says which one opens — `children: 'alike' | 'assorted'` — and the reader can change it, remembered per resource. The order is: what they just picked, then what they picked here last, then what the node said.

That order is what makes the declaration safe to add. A wrong `alike` costs a click, not a screen. It is the line the `defaultColumns` comment already draws — which columns come first is the resource's advice, which columns you end up looking at are yours — applied one level up.

**Actions are drawn wherever rows are**, through the commanding path the grid already used: one idempotency key per press, `confirm` honoured, the outcome in the tray. The argument is the **object's** id, never the occurrence's — a tree row's id is where a thing sits in one arrangement, and `delete` against that would remove a document's place in a folder and report that it had deleted the document.

**Three panes where there is room**: the tree, the rows of the branch it scopes, and the row that was opened. Three depths of one question — which set, which row, which fields.

**A branch may name the child that opens with it**, `defaultChild`, which is what makes a folder open on its README. Advice, and bounded twice: an id the branch did not answer with is ignored, and a viewer with something already open leaves it open.

## What the fixture changed

The serial-port example was built to be looked at, and it is the reason four of these are the shape they are. None of the four was visible on paper.

**Actions needed to say which rows they are about.** Within a minute of pointing the console at the rack, `reset` and `close` were drawn on cabinets and hubs, where `resetPort` throws. A flat list never has this problem — every row of one is the same kind of thing — and a tree's rows are not. The codebase's own rule about guessing here is unambiguous, so `RpcDataAction` gained `appliesTo`, absent meaning leaves: no change for a list, whose rows have no children and are all leaves, and the safe half for a tree, because the failure it prevents is a command offered against the wrong kind of thing.

**A level that is entirely branches is scope, not content.** Opening the rack on values tabulated the roots — two cabinets, which have none of `port`, `baudrate`, `status` or `errors` — so the header sat over four columns of blanks, which is the exact failure the arrangement exists to avoid, arriving at the one moment nobody has chosen anything yet. Read from `hasChildren`, which came with the branch: where every row of a level has children the table says to pick one.

**`alike` is a claim about siblings, not about leaves.** The plan left open whether `alike` should promise that a branch's children are the end of the tree. It should not: the cabinets under the root are alike, and so are the hubs under a cabinet. Nothing needed restricting.

**The breakpoints dissolved.** The plan asked where they should go; the answer is nowhere. This same component draws inside the console's middle column and again in the full-page observer, which are very different widths at the same window size — a breakpoint on the window would give the narrow one three cramped columns and the wide one an empty third of a screen. Wrapping on flex-basis asks how much room *this* pane has, which is the question that was meant.

A fifth thing the fixture did not change but did prove: `validateResults` on the example caught `resources[0].children: not part of this type` when the introspection contract had been re-extracted and the library not rebuilt. Re-extraction writes into `packages/rpc/src`, so the build has to follow it.

## Where metadata lives, per format

The document library reads YAML front matter from Markdown, and `topics:` in it is what the `by-topic` aspect is built from — so a document already declares its own placement in an aspect, and has since before any of this.

The question that follows is what happens when the README is not Markdown. **The answer is not to carry front matter into it.** `DocumentReader.read(text, name)` returns `{ title?, topics, blocks }` and each reader knows how its own format declares things: `frontMatter` is a helper the Markdown reader uses, not a rule the library imposes. HTML already has `<title>` and `<meta name="topics" content="…">`, which is that format's own way of saying it; a `---` block inside an HTML comment would be importing one format's convention into another that has its own, and the seam is there precisely so that is not necessary.

The same reasoning settles a folder-level `.aspects.json`, which was considered and dropped: what a folder says about itself belongs in the README, which is now formally the thing a folder opens on.

## What is not built

The arrangement is per resource, not per branch. A resource that is genuinely both — a hierarchy whose upper levels are assorted and whose lower ones are alike — declares one thing for all of it, and the pure-scope rule above happens to cover the common case of that. A resource that is really two is two resources.

`getOne` is served but no store-backed read side declares it. `relational` and `document` still answer `getList`, `getMany` and `getManyReference`, and their reason survives: a table's row is the same shape read one at a time or fifty, so `getOne` there would be `getMany` with one id under another name.

Nothing consumes `children` except the console. That is fine and expected — it is a declaration about data, and a second viewer would read it the same way.

## Afterwards: the choice did not survive contact

*Added at `f3d7bfb`+, after the console was used against a real address space rather than a fixture.*

The two arrangements and the toggle between them are gone, and so is `children: 'alike' | 'assorted'`. There is one arrangement: the tree holds branches and is scope, the table holds the rows of the branch that is picked, and the panel beside them holds what a row cannot — a document's text, a node's every attribute.

The reasoning above was not wrong about the *shapes*; it was wrong that a reader has to choose between them. What the second arrangement offered — leaves drawn in the tree — turned out to be the same view with a different pane in focus, and a leaf in a tree is a row nobody can read across. The document case, which is the one the toggle was built to protect, reads perfectly well as folders on the left and documents as rows: it is the arrangement somebody wants when *organising* rather than reading, and reading is one click away in the panel.

So the declaration went with it. `children` existed to pick which arrangement opened; with one arrangement it decided nothing, and a contract field expressing a choice nobody makes is the speculative surface `defaultColumns` is written to keep off the wire. If a second arrangement ever earns its place, the field can come back with it.

What did survive, and is worth separating from what did not: `appliesTo` on an action, the pure-scope rule for a level of nothing but branches, `getOne`, `defaultChild`, and the object's id rather than its occurrence's. Those were all found the same way and none of them depended on there being two views.

Still open, raised while looking at it: the columns are whatever the resource named, and a reader cannot choose others. A column selector, remembered per reader in the browser, is the obvious next thing and is not built.
