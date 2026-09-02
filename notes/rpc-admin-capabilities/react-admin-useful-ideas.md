<!--
Reading notes, scrubbed.

These are transcripts of an outside model's evaluation of react-admin against this repository, kept
because the reasoning is worth having and hard to reconstruct. Two things were removed before they
were committed: the product names and roadmap of the commercial application layer above Source RPC,
which is not this repository's to publish, and the private conversation link the export carried. The
roles those products played survive as descriptions - "a control-facing application" and so on -
because the argument depends on the role rather than on the name.

What was taken from these, what was refused and in what order it is being built is in
`notes/generic-viewer.md`. These are the input; that is the decision.
-->

# Evaluate React Admin Features

## Prompt:
9/2/2026, 2:54:47 PM

One source of ideas for https://github.com/source-repo/rpc is react-admin https://marmelab.com/react-admin/documentation.html with source at https://github.com/marmelab/react-admin.
The generic DataProvider interface and the UI forms and components are nice concepts. I have also seen some limitations with lack of typings for example that we should not emulate I guess. Please evaluate what features are useful for the the application layer Source concepts different parts

## Response:
9/2/2026, 2:54:52 PM

I’ll compare react-admin’s abstractions with Source RPC as it exists now, then map the useful parts to the assessment application, the portfolio application, the change-proposal application, a control-facing application, and the generic knowledge/console layer. I’ll pay special attention to where react-admin’s JavaScript-era flexibility becomes a liability for Source’s stronger typed/RPC model.

The first important finding is that Source RPC has already moved further toward the react-admin idea than the top-level README alone suggests: it now explicitly exposes MongoDB, SQL, and Docker through `DataProvider` resources, with a conformance package behind that abstraction. That makes react-admin especially relevant as a UI/projection reference, not as a backend abstraction to copy wholesale.

There’s also a useful contrast in the current typings. React-admin has improved—its newer `DataTable.Col<T>` can type-check field paths—but the core provider still has `filter?: any`, `meta?: any`, `field: string`, an open `[key: string]: any`, and a record type generic that is not actually tied to the resource name. That is exactly the kind of “looks typed at the call site” design Source should avoid.

> **Searching the web**
>
> [react-admin/docs/Features.md at master · marmelab/react-admin · GitHub](https://github.com/marmelab/react-admin/blob/master/docs/Features.md)
> [React-admin - Documentation](https://marmelab.com/react-admin/documentation.html)
>
> **Searched 2 websites**
>
> 
>
> **Searching the web**
>
> [rpc/packages/rpc/src/RPC/DataProvider.ts at main · source-repo/rpc · GitHub](https://github.com/source-repo/rpc/blob/main/packages/rpc/src/RPC/DataProvider.ts)
>
> **Explaining RPC design**
>
> I’m summarizing how this RPC layer mirrors react-admin’s data-provider verbs, why reads are pull-based, and how typed filtering, pagination, references, and tree browsing support small plant peers without arbitrary evaluators.
>
> **Mapping data and writes**
>
> I’m outlining response metadata, resource presentation hints, row actions, validation behavior, and guarded write semantics. Writes use explicit create, update, or delete operations, while conflicts and missing records remain visible outcomes.
>
> **Clarifying concurrency and compatibility**
>
> I’m distinguishing missing records and conflicts as ordinary domain outcomes, while tracking optimistic concurrency separately. I’m also connecting the design to common admin needs: references, typed tables, forms, trees, and introspection.
>
> **the assessment applicationing type safety**
>
> I’m separating genuinely typed paths from remaining flexible fields, then mapping useful admin capabilities onto Source layers. My main recommendation is borrowing semantic contracts and composable UI without adopting a full CRUD worldview.
>
> **Designing console semantics**
>
> I’m proposing typed identity and reference metadata, schema-driven field and input factories, headless controllers, and action forms. I’m preserving explicit command semantics, server authority, revision handling, and cautious realtime behavior rather than generic optimistic CRUD.
>
> **Explained RPC design, data writes, concurrency, compatibility, and type safety**
>
> 
>
> **Searching the web**
>
> [React-admin - The DataTable Component](https://marmelab.com/react-admin/DataTable.html)
> [GitHub - source-repo/rpc: Source RPC - One programming model for a network of peers · GitHub](https://github.com/source-repo/rpc)
> [raw.githubusercontent.com](https://raw.githubusercontent.com/marmelab/react-admin/master/packages/ra-core/src/types.ts)
>
> **Mapping Source layers**
>
> I’m organizing the evaluation by Source’s RPC core, console, schemas, aspects, assessment, operations, simulations, edge integrations, and MCP. I’ll treat React-admin as a useful data-UI grammar, not a complete architectural model.
>
> **Prioritizing integration**
>
> I’m identifying the highest-value next step: semantic metadata and a typed UI layer over TypeNode. I’ll avoid treating generic resource strings, weak payload fields, or CRUD abstractions as universal backend boundaries.
>
> **Mapped Source layers and prioritized integration**
>
> 
>
> **Searched 1 website**
>
> 
>
> Worked for 4m 3s

Yes. React-admin is a very good source of ideas for Source, but mainly as a **vocabulary for turning unknown data models into useful user interfaces**, not as an architecture to copy.

What is interesting is that the current Source RPC code has already made this distinction quite well. `DataProvider.ts` explicitly says the shape comes from react-admin, including `getMany` for references and `getManyReference` for one-to-many relationships. But Source has already departed from react-admin where the industrial/distributed context calls for it: bounded filtering, tree browsing, command semantics, explicit row actions, runtime schemas, and deliberately restricted writes. ([GitHub](https://raw.githubusercontent.com/source-repo/rpc/main/packages/rpc/src/RPC/DataProvider.ts))

## The main idea I would borrow

I would think of react-admin as having discovered a useful generic UI grammar:

> **Resource → Collection → Record → Field → Relation → Action**

That grammar is remarkably applicable to Source even though Source isn't an admin framework.

For Source it becomes more like:

> **Peer → Component → Aspect/Resource → Collection/Tree → Occurrence/Record → Property/Relation → Action**

The generic UI then doesn't need to understand MongoDB, OPC UA, Linear, a PLC, a knowledge document, Docker, or a SQL database. It understands those few semantic concepts.

That is potentially a fairly important piece of the overall Source architecture.

### Where the react-admin ideas fit

| React-admin idea | Source equivalent | Particularly useful for | Recommendation |
|---|---|---|---|
| `DataProvider` | `$data` / `RpcDataResource` | Everything | **Already good** |
| `Resource` | resource/aspect in component scope | Console, knowledge system | **Adopt conceptually** |
| `<List>` / `DataTable` | generic resource viewer | the assessment application, the portfolio application, Console | **Strongly adopt** |
| `<Show>` | generic detailed record view | the assessment application, OPC UA, knowledge | **Strongly adopt** |
| `<Edit>` / `<Create>` | generated method/write form | the change-proposal application, DB resources | **Adapt carefully** |
| Field components | schema-derived renderers | Everywhere | **Strongly adopt** |
| Input components | schema-derived form inputs | Actions, configuration | **Strongly adopt** |
| `ReferenceField` | resource relationship | Knowledge, OPC UA, Linear, assets | **Very valuable** |
| `recordRepresentation` | canonical human label for an ID | Almost everywhere | **Worth adding** |
| configurable columns | viewer preferences | Console, the portfolio application, the assessment application | **Strongly adopt** |
| saved filters/queries | saved Source queries/views | the portfolio application, the assessment application, knowledge | **Strongly adopt** |
| controllers/hooks | headless Source UI library | custom applications | **Strongly adopt** |
| guessers | generate UI from TypeNode | Console/dev tooling | **Source can do this better** |
| realtime views | state subscriptions + refresh | a control-facing application, simulation | **Adapt to Source semantics** |
| locks | leases/authority/concurrency state | the change-proposal application, collaborative editing | **Semantic equivalent, don't copy literally** |
| RBAC UI | capability-aware rendering | applications | **Useful UX, never authorization** |
| optimistic/undoable edits | mutation UX | ordinary SaaS data | **Mostly inappropriate for a control-facing application** |
| bulk update/delete | bulk mutation | - | **Do not copy generically** |

React-admin itself now has a huge catalogue of reusable fields and inputs-references, arrays, dates, booleans, numbers, files, trees, autocomplete inputs, etc.-and that catalogue is useful almost as a checklist of what a generic Source viewer eventually needs to know how to render. ([marmelab.com](https://marmelab.com/react-admin/Inputs.html))

---

# 1. Source RPC itself: keep it semantic, not visual

I think the current boundary in `RpcDataResource` is particularly good:

```ts
interface RpcDataResource {
    path: RpcResource
    row?: TypeNode
    verbs: RpcDataMethod[]
    shape?: 'list' | 'tree'
    label?: string
    presentation?: {
        defaultColumns?: string[]
    }
    actions?: RpcDataAction[]
}
```

And especially this comment in the implementation:

> no widths, colours, component names...

The node knows which columns are important; the user/viewer knows whether they want a 200 px column, a compact table, or cards. That separation should remain. ([GitHub](https://raw.githubusercontent.com/source-repo/rpc/main/packages/rpc/src/RPC/DataProvider.ts))

I would therefore **not** start adding things like:

```ts
component: 'NumericField'
width: 120
color: 'green'
layout: 'tabs'
```

to the RPC contract.

But there is another category between *type information* and *UI layout*: **semantic presentation information**. That's where I think react-admin points to a few gaps worth filling.

## Record representation

React-admin has the concept of a `recordRepresentation`: given a customer ID of `38271`, the UI should preferably display `"Volvo Cars"` rather than `38271`. Its reference and navigation components rely heavily on this concept. React-admin exposes record-representation primitives alongside breadcrumbs and reference fields. ([marmelab.com](https://marmelab.com/react-admin/DataProviders.html))

Source could use this almost everywhere.

Imagine:

```ts
interface RpcDataPresentationHint {
    defaultColumns?: readonly string[]
    representation?: readonly string[]
}
```

For example:

```ts
representation: ['name']
```

or perhaps:

```ts
representation: ['tag', 'description']
```

I prefer field paths over format strings or callbacks because they're introspectable, portable, and verifiable against `TypeNode`.

This becomes useful for:

- OPC UA nodes
- PLC symbols
- alarms
- devices
- Linear issues
- files/documents
- database rows
- team members
- plant assets
- knowledge occurrences

It also improves confirmation prompts automatically:

**Restart `Boiler feed pump P-104`?**

instead of:

**Restart `b92c21af`?**

That is small metadata with disproportionately large value.

---

# 2. References are probably the biggest react-admin idea still worth developing

The Source DataProvider already has the underlying mechanics.

`getMany()` exists specifically so 50 rows containing customer IDs don't cause 50 RPC round trips, while `getManyReference()` handles the reverse one-to-many direction. That's exactly the right abstraction. ([GitHub](https://raw.githubusercontent.com/source-repo/rpc/main/packages/rpc/src/RPC/DataProvider.ts))

What I don't see in `RpcDataResource` is a generic way for introspection to say:

> `customerId` isn't merely a string. It refers to the `customers` resource.

React-admin knows that because the application author writes:

```tsx
<ReferenceField source="customerId" reference="customers" />
```

Source has an opportunity to put that relationship into the data model instead.

Something approximately like:

```ts
interface RpcDataReference {
    field: string
    target: RpcResource
}

interface RpcDataResource {
    // ...
    references?: readonly RpcDataReference[]
}
```

Then a completely generic Source Console can discover:

```text
orders.customerId
        ↓
customers
```

and automatically:

- render the customer's human-readable representation;
- make it clickable;
- batch `getMany()` calls;
- offer an autocomplete when editing;
- show `"Orders"` under the customer using `getManyReference`;
- expose the same relationship to MCP.

This is particularly interesting for the **the knowledge model**. References begin turning arbitrary resources into a navigable graph without introducing a separate graph protocol.

A document can reference an asset. An alarm can reference a PLC symbol. An issue can reference a Source component. An occurrence in one aspect can refer to the underlying entity.

That seems more fundamental than merely making nicer tables.

---

# 3. Source Console: this is where a lot of react-admin should be borrowed

I wouldn't make the Source console *use react-admin* as its architecture. But I would absolutely steal its decomposition.

A Source UI package could eventually have headless concepts along the lines of:

```ts
useDataList(...)
useDataRecord(...)
useDataChildren(...)
useReferences(...)
useDataAction(...)
useResourcePermissions(...)
```

with components built over them:

```tsx
<ResourceList />
<ResourceTable />
<ResourceTree />
<ResourceShow />
<ResourceField />
<ResourceAction />
<RpcForm />
```

The important part is that the controller/data layer doesn't depend on the visual components.

React-admin's split between controllers/context and views is one of its better ideas. It means a standard list can be replaced by cards, a custom visualization, a dashboard widget, etc., while retaining pagination/filtering/loading/error handling.

For Source that matters even more because **the same resource may be projected differently in different aspects**.

A table may be the right projection in the Source Console while the same data becomes a plant hierarchy or graphical view in the assessment application.

---

# 4. Forms are an especially strong fit

This might actually work *better* in Source than in react-admin.

React-admin has to be told:

```tsx
<SimpleForm>
    <TextInput source="name" />
    <NumberInput source="setpoint" />
    <SelectInput source="mode" choices={...} />
</SimpleForm>
```

Source already has method parameter schemas.

And `RpcDataAction` already explicitly specifies that the selected row fills the first argument and the remaining arguments are to be requested from the user. For example, the code comments describe exactly the distinction between:

```ts
retryDeadLetter(taskId)
```

and:

```ts
write(nodeId, value)
```

where the second naturally produces a form for `value`. ([GitHub](https://raw.githubusercontent.com/source-repo/rpc/main/packages/rpc/src/RPC/DataProvider.ts))

That's a very powerful generic mechanism.

Given:

```ts
@rpc({ semantics: 'idempotent-command' })
async configure(
    motorId: string,
    acceleration: number,
    mode: 'eco' | 'normal' | 'fast',
    enabled: boolean
) {}
```

the console should be able to derive something conceptually equivalent to:

```text
Motor
  M-103                        [bound]

Acceleration
  [ 2.5                  ]

Mode
  ( ) eco
  (x) normal
  ( ) fast

Enabled
  [✓]

                  [ Configure ]
```

with essentially no UI code.

That applies beautifully to **OPC UA configuration**, Source adapters, Docker operations, development tooling and eventually parts of the change-proposal application.

The UI components from react-admin are therefore very relevant as a **catalogue of input concepts**, but Source should select them from its TypeNode schema rather than requiring the application author to repeat the type information. ([marmelab.com](https://marmelab.com/react-admin/Inputs.html))

---

# 5. The "Guesser" idea becomes much better in Source

React-admin has `ListGuesser`, `ShowGuesser`, etc. They are partly development conveniences because react-admin otherwise doesn't know enough about the backend.

Source does.

It has `describe()`, TypeNode, resource metadata, action metadata, and method schemas.

So instead of a "guesser", Source can have a **deterministic schema renderer**:

```text
TypeNode
   ↓
generic view
```

No guessing from example JSON.

And perhaps a developer can click:

**Generate TSX**

to get the current automatically generated view as editable source:

```tsx
<ResourceTable resource={...}>
    <Column source="tag" />
    <Column source="description" />
    <Column source="state" />
</ResourceTable>
```

That would create a very nice progression:

```text
Zero code
   ↓
automatic generic viewer
   ↓
generated starting point
   ↓
custom React projection
```

That fits the Source philosophy unusually well.

---

# 6. Configurable tables should mostly be viewer state

React-admin's current `DataTable` supports hiding/reordering columns, row selection and other generic table behavior. Its newer column API also fixed an acknowledged problem in the old `Datagrid`: column sources previously weren't strongly typed enough. ([marmelab.com](https://marmelab.com/react-admin/DataTable.html))

Source's current `defaultColumns` design already leads in the right direction:

```text
Node:
    "These are the useful initial columns."

Viewer:
    "I want these columns."
    "In this order."
    "At these widths."
```

For the application layer, user preferences could then store things such as:

```ts
{
    columns: ['tag', 'description', 'value', 'quality'],
    sort: ...,
    filters: ...,
    pageSize: 50
}
```

per resource/aspect/user.

That would be especially valuable in **the portfolio application**, **the assessment application**, and the generic Source Console.

I would probably call these **views** eventually rather than merely table preferences, because the same mechanism can grow into:

```text
All alarms
Unacknowledged alarms
Safety-related alarms
My open assessment findings
Devices with stale firmware
```

Each can simply be a named combination of scope + filter + sort + selected fields.

React-admin's saved-query/preferences concepts are a useful precedent here. ([marmelab.com](https://marmelab.com/react-admin/DataProviders.html))

---

# 7. Trees: Source is already arguably ahead

React-admin has tree inputs and hierarchical UI concepts. Source's `getChildren` model is much more important for the applications because hierarchy isn't an occasional admin feature-it is fundamental.

The current Source distinction between:

- `hasChildren`
- `grouping`
- `defaultChild`

is particularly useful. The OPC UA example in the current source is a good illustration: a Variable may have property children without therefore being a navigational "folder." ([GitHub](https://raw.githubusercontent.com/source-repo/rpc/main/packages/rpc/src/RPC/DataProvider.ts))

This will matter for:

- OPC UA
- IEC 81346/aspect structures
- document knowledge trees
- filesystems
- Linear/project hierarchies
- PLC structures
- network topology
- Source component browsing

So here I would borrow **react-admin's UX experience**, but not its underlying tree abstraction.

---

# 8. An assessment application

For Source the assessment application, react-admin's strongest ideas are the read-oriented ones:

```text
List
Show
Field
ReferenceField
ReferenceManyField
Filter
SavedQuery
Breadcrumb
RecordRepresentation
Export
```

The assessment application is largely an ideal case for generic schema-derived browsing.

For example:

```text
PLC
 └── Program
      └── Function block
           ├── Issues
           ├── Evidence
           ├── Behaviour reviews
           └── References
```

The useful lesson from react-admin isn't that those should all become CRUD tables. It's that each node can expose a standard **collection/detail/reference vocabulary**, allowing one generic UI to provide surprisingly rich navigation.

This becomes even more interesting with the newer Source aspect model because different resource arrangements can reuse exactly the same viewers.

---

# 9. A portfolio application

The portfolio application seems particularly well suited to the **saved view / configurable list** side.

The underlying data might be:

```text
assessment findings
assets
systems
risks
open actions
modernisation items
KPIs
```

Then The portfolio application defines projections such as:

```text
Highest business risk
Systems needing management decision
Changes since last assessment
Unresolved continuity risks
```

That can often just be:

```text
resource
+ aspect/scope
+ filter
+ sort
+ selected columns
+ perhaps aggregation
```

This is an area where react-admin can provide many UX ideas without Source becoming anything like an admin application.

---

# 10. A change-proposal application

The change-proposal application benefits much more from the form side:

```text
Show current
→ edit proposed
→ validate
→ compare
→ test
→ accept/reject
```

React-admin's edit forms, form layouts, validation and dirty-state handling are all useful inspiration.

But Source should add the thing ordinary CRUD frameworks often hide: **the state transition**.

An edit isn't simply:

```ts
update('motor', { speed: 500 })
```

It might mean:

```text
baseline
   ↓
proposal
   ↓
simulation
   ↓
review
   ↓
approved change
```

So react-admin's forms are useful; its mental model of "edit database record and save" should not become the change-proposal application's model.

---

# 11. A control-facing application, where not copying react-admin matters most

React-admin supports pessimistic, optimistic and "undoable" mutation modes. In its default undoable edit mode it changes the local UI first and delays sending the actual mutation for several seconds. ([marmelab.com](https://marmelab.com/react-admin/Edit.html))

That's great UX for:

> Change customer's surname.

It's an awful generic semantic for:

> Start conveyor.

Source already has exactly the abstraction needed to do better:

```ts
query
idempotent-command
non-repeatable-command
```

plus `UnknownOutcome`, deadlines and idempotency handling. ([GitHub](https://github.com/source-repo/rpc))

So the UI should derive behavior from **RPC semantics**, not from a generic UI mutation mode.

For example:

| RPC semantics | UI behavior |
|---|---|
| `query` | freely refresh/cache/retry |
| `idempotent-command` | submit once; retry may be possible |
| `non-repeatable-command` | pessimistic; explicit in-progress; never silently retry |
| `UnknownOutcome` | special prominent state: outcome must be verified |
| `confirm: true` | explicit confirmation before dispatch |

That's actually one place where Source could demonstrate a substantially better model than typical web admin frameworks.

---

# 12. Keep the current rejection of generic bulk mutations

React-admin's DataProvider includes `updateMany` and `deleteMany`. ([GitHub](https://raw.githubusercontent.com/marmelab/react-admin/master/packages/ra-core/src/types.ts))

Source deliberately doesn't.

The explanation in `DataWrites.ts` is compelling: fifty changes mean fifty individually preconditioned, auditable, refusable operations rather than a generic destructive operation over a selection/filter. ([GitHub](https://raw.githubusercontent.com/source-repo/rpc/main/packages/rpc/src/RPC/DataWrites.ts))

I would keep that.

The **UI selection model** is still useful, though.

Selecting 23 rows could mean:

```text
Compare
Export
Add to assessment
Open as view
Run action on each...
```

If "run action on each" is supported, it can explicitly execute 23 bounded individual RPC calls and show:

```text
21 succeeded
1 conflicted
1 refused
```

rather than inventing a generic `updateMany`.

That's a nice example of borrowing react-admin UX without borrowing its protocol.

---

# 13. Typing: Source should deliberately be stricter

Your concern here is justified.

React-admin has improved considerably. For example `DataTable.Col<Review>` now gives typed source paths. ([marmelab.com](https://marmelab.com/react-admin/DataTable.html))

But its core still contains things such as:

```ts
interface SortPayload {
    field: string
}

interface FilterPayload {
    [k: string]: any
}

interface GetListParams {
    filter?: any
    meta?: any
}
```

and:

```ts
type DataProvider<ResourceType extends string = string> = {
    getList: <RecordType extends RaRecord = any>(
        resource: ResourceType,
        ...
    ) => ...
    
    // ...
    
    [key: string]: any
}
```

([GitHub](https://raw.githubusercontent.com/marmelab/react-admin/master/packages/ra-core/src/types.ts))

There's a subtle typing problem there too:

```ts
dataProvider.getList<User>('orders', ...)
```

is type-correct even though `"orders"` and `User` need have no relationship whatsoever. The generic record type is supplied independently by the caller.

Source should avoid that kind of **caller-asserted typing**.

For statically known resources, the ideal TypeScript shape is closer to:

```ts
interface Resources {
    users: User
    orders: Order
}

type DataProvider<R extends Record<string, unknown>> = {
    getList<K extends keyof R>(
        resource: K,
        params: GetListParams<R[K]>
    ): Promise<GetListResult<R[K]>>
}
```

Now:

```ts
getList('orders', ...)
```

necessarily returns `Order`.

But Source has an important second case that react-admin doesn't solve with TypeScript generics: **resources discovered at runtime**.

A connected PostgreSQL node may discover a table that did not exist when the console was compiled.

For that case, pretending compile-time typing exists would be wrong. Source's current solution-`unknown` at the wire boundary plus a runtime `TypeNode`-is the right idea. ([GitHub](https://raw.githubusercontent.com/source-repo/rpc/main/packages/rpc/src/RPC/DataProvider.ts))

So I would deliberately support two worlds:

```text
Known at compile time
    → real TypeScript types

Discovered at runtime
    → TypeNode runtime types
    → dynamically typed UI controls
    → validation before operations
```

Not an `any` compromise between them.

---

# 14. Filters are another area where Source is already better

React-admin deliberately leaves the actual filter object to the backend, hence `filter?: any`. ([GitHub](https://raw.githubusercontent.com/marmelab/react-admin/master/packages/ra-core/src/types.ts))

That's flexible, but it prevents generic reasoning.

Source has:

```ts
type RpcFilterOp =
    | 'startsWith'
    | 'contains'
    | 'eq'
    | 'ne'
    | 'lt'
    | 'lte'
    | 'gt'
    | 'gte'
```

and bounded `all` / `any` trees. The code explicitly rejects an executable predicate language because these filters may be evaluated on small plant computers. ([GitHub](https://raw.githubusercontent.com/source-repo/rpc/main/packages/rpc/src/RPC/DataProvider.ts))

I strongly prefer the Source approach.

I would take it one step further in the **TypeScript/UI API**, even if the wire format stays as-is.

A numeric TypeNode should offer:

```text
= ≠ < ≤ > ≥
```

A string should offer:

```text
= ≠ starts with contains
```

A boolean:

```text
= ≠
```

The generic filter editor could therefore itself be completely schema-driven and make invalid filters difficult to construct.

---

# 15. Authorization: borrow the UX, not the security model

React-admin has `canAccess()`-style UI authorization and can use it to hide or expose resource actions. Its normal architecture separates authentication into an `authProvider`. ([marmelab.com](https://marmelab.com/react-admin/DataProviders.html))

There is something useful there:

> Don't show a button the user can't use.

Source already has a better security boundary, though: `authorize()`, authenticated peers, owner fencing, permissions etc. A React UI can never be authoritative.

So Source should expose sufficient capability information to render a truthful UI, but authorization remains on the node.

Conceptually:

```text
Permission/capability introspection
        ↓
UI decides what to show
        ↓
RPC call
        ↓
authorize() decides whether it happens
```

Never:

```text
Button was hidden
        ↓
therefore secure
```

That distinction becomes extremely important for a control-facing application and MCP.

---

# 16. MCP may benefit as much as the human UI

This is where I think the react-admin-inspired work gets especially interesting.

Suppose Source adds:

```text
row schema
references
record representation
actions
action applicability
confirm semantics
resource shape
default columns
writeable fields
```

That isn't just UI metadata.

An MCP client can use the same information to understand:

```text
"This is an Orders resource."
"`customerId` references Customers."
"`restart` applies only to leaves of kind Device."
"`setAddress` needs a string argument."
"`delete` requires confirmation."
```

So I would resist naming this the **UI schema**.

It is closer to a **resource semantic model**, from which UI happens to be one consumer:

```text
               Resource semantics
                /      |       \
               /       |        \
        Browser UI    MCP      CLI
```

That is very Source-like.

---

# A three-layer model

This is the architectural division I would use going forward:

| Layer | Contains | Does **not** contain |
|---|---|---|
| **Resource contract** | schema, relationships, actions, capabilities, command semantics | UI layout |
| **Presentation semantics** | label, representation, default fields, units/semantic formats | pixel widths, colors, React components |
| **Viewer preferences** | selected columns, widths, ordering, saved views, layout | node contract |

The current `defaultColumns` design already sits correctly in the middle layer.

React-admin has accumulated all three categories inside one framework because it controls both the application and UI. Source should keep them distinct because the same component may be consumed by a browser console, an assessment application, a custom SCADA-adjacent UI, CLI, MCP, or something nobody has written yet.

## What I would prioritize

1. **Add first-class reference metadata and record representation.** Those two concepts unlock dramatically better generic navigation, especially for the knowledge/aspect system.

2. **Build schema-derived `Field` and `Input` primitives.** The same TypeNode should drive tables, detail views and RPC action forms.

3. **Turn the existing automatic console into a real headless resource UI layer.** Separate list/detail/action controllers from the standard visual components, taking inspiration from react-admin's controllers/contexts.

4. **Add saved views and configurable resource tables entirely above RPC.** `defaultColumns` seeds the view; users own everything after that.

5. **Generate forms from RPC signatures and writable-resource schemas.** Source already has most of the underlying information.

6. **Make command semantics visibly affect UI behavior.** This is where Source should *not* imitate generic CRUD systems and where a control-facing application can be substantially safer.

7. **Use the exact same semantic model for MCP.** Avoid creating one set of annotations for humans and another for AI.

So I think react-admin is a better reference for Source than merely “there's a nice generic DataProvider”. It has spent years discovering **what information a generic client needs in order to present arbitrary structured systems coherently**. Source can take that accumulated UX vocabulary, strip away the CRUD/web assumptions, make the type relationships much stricter, and apply it to a substantially broader problem.

And interestingly, the current `DataProvider`, `getChildren`, row actions and `defaultColumns` code show that Source has already started moving in exactly that direction. ([GitHub](https://raw.githubusercontent.com/source-repo/rpc/main/packages/rpc/src/RPC/DataProvider.ts))

---

**Sources:**

- [](https://raw.githubusercontent.com/source-repo/rpc/main/packages/rpc/src/RPC/DataProvider.ts)
- [React-admin - Input Components](https://marmelab.com/react-admin/Inputs.html)
- [GitHub - source-repo/rpc: Source RPC - One programming model for a network of peers · GitHub](https://github.com/source-repo/rpc)

---
Powered by [ChatGPT Exporter](https://www.chatgptexporter.com)