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

Q) Great, please distribute these ideas over existing and new packages, a table maybe

A) Yes. Given the packages that exist today, I would **not** create one big `react-admin`-inspired package. The ideas fall quite naturally across the existing structure, with only about three or four new packages worth introducing.

The repo currently has `rpc`, `aspects`, `query`, `continuity`, `diagnostics`, `document`, `relational`, `opcua`, `docker`, `queue`, `cli`, etc. ([GitHub][1])

## Proposed distribution

| Package                    | Existing / new             | Owns                                        | React-admin ideas landing here                                                                                                             |
| -------------------------- | -------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `@source-repo/rpc`         | **Existing**               | Universal resource contract and semantics   | DataProvider, resource capabilities, references, record representation, semantic formats, action metadata, effective capability projection |
| `@source-repo/aspects`     | **Existing**               | Alternative structures/navigation contexts  | `AppLocation`-like contextual navigation, placements, breadcrumbs, aspect-preserving links                                                 |
| `@source-repo/query`       | **Existing**               | Client-side resource access/cache/freshness | Headless data controllers underneath UI, realtime invalidation, collection/record observation                                              |
| `@source-repo/conformance` | **Existing**               | Contract behaviour tests                    | DataProvider/reference/search/history capability conformance                                                                               |
| `@source-repo/document`    | **Existing**               | MongoDB-backed resources                    | Infer labels/relationships/schema/semantic metadata from Mongo collections                                                                 |
| `@source-repo/relational`  | **Existing**               | SQL-backed resources                        | Infer FK relationships, record identity, labels, schemas                                                                                   |
| `@source-repo/opcua`       | **Existing**               | OPC UA projection                           | Tree/resource semantics, semantic types/units, references, generated actions/forms                                                         |
| `@source-repo/continuity`  | **Existing**               | Runtime replacement and state handoff       | **Keep separate** from generic record history; possibly supply specialised revision/change views                                           |
| `@source-repo/diagnostics` | **Existing**               | Live engineering diagnostics                | Specialised realtime/source views built on generic UI primitives                                                                           |
| `@source-repo/cli`         | **Existing**               | CLI, MCP, Console application               | Consume resource semantics/search/UI packages; shouldn't become owner of generic UI machinery                                              |
| `@source-repo/react`       | **New**                    | Generic React client/view toolkit           | Headless hooks, List/Show/Field/Input/Form/Reference/Table/Tree, schema-driven rendering                                                   |
| `@source-repo/search`      | **New**                    | Federated Source-network search             | Enterprise global search/omnibox, semantic Source locators                                                                                 |
| `@source-repo/revisions`   | **New**                    | Logical resource revision history           | History, diff, version comparison, optional restore                                                                                        |
| `@source-repo/audit`       | **New**                    | Event/action history                        | Audit log, timelines, who/what/why, continuity evidence                                                                                    |
| Application layer  | **Not Source RPC package** | Product workflows/views/preferences         | portfolio dashboards, change-proposal workflows, assessment intake, saved views, calendars, wizards                                                      |

The React-admin Enterprise catalogue is useful precisely because it covers both generic resource concepts and higher-level application functionality: audit, history, navigation, preferences, RBAC, realtime, relationships, search, tree, headless core, etc. ([React-Admin Enterprise Edition][2])

### 1. `@source-repo/rpc`: keep the small universal vocabulary here

This is where I would put anything that a **non-React consumer such as MCP** needs to understand.

For example, extending `RpcDataResource` approximately toward:

```ts
interface RpcDataResource {
    path: RpcResource
    row?: TypeNode
    verbs: RpcDataMethod[]
    shape?: 'list' | 'tree'

    label?: string

    presentation?: {
        defaultColumns?: string[]
        representation?: string[]
    }

    references?: RpcDataReference[]

    capabilities?: {
        search?: boolean
        revisions?: boolean
        audit?: boolean
        realtime?: boolean
    }

    actions?: RpcDataAction[]
}
```

I wouldn't necessarily use literal booleans long term; some capabilities will need descriptors. But **the vocabulary belongs here**.

Likewise semantic type hints:

```ts
{
    type: 'string',
    format: 'markdown'
}
```

or:

```ts
{
    type: 'number',
    unit: '°C'
}
```

belong near TypeNode/resource metadata rather than in React.

This gives:

```text
                @source-repo/rpc
                       │
             semantic contract
          ┌────────────┼────────────┐
          ↓            ↓            ↓
        React         MCP          CLI
```

That's important.

---

## 2. `@source-repo/aspects`: own the AppLocation idea

This package already explicitly says that structure is an aspect while identity is not, and supports alternative placements of one underlying object. ([GitHub][3])

So I would make it the clear owner of:

* current aspect;
* current occurrence/placement;
* aspect-aware navigation context;
* breadcrumbs;
* `follow()` preserving the reader's intended aspect;
* possibly a generic `NavigationLocation`.

For example:

```ts
interface NavigationLocation {
    aspect: AspectId
    occurrence?: OccurrenceId
    target: RpcLocator
    ancestors: OccurrenceId[]
}
```

This is the Source equivalent of react-admin EE's useful separation between browser URL and logical application location.

I would **not** put general relationships in `aspects`.

These are different:

```text
Pump appears under Cooling System
        → aspect placement

Pump is supplied by VFD-104
        → relationship
```

That distinction should remain.

---

## 3. References/relationships: contract in `rpc`, discovery in providers

Rather than a separate `relationships` package immediately, I'd put the generic relationship vocabulary into `rpc`.

Then individual provider packages populate it.

### `@source-repo/relational`

This is an obvious win.

It already introspects SQL schemas and primary keys to create resources dynamically. ([GitHub][4])

It could also inspect foreign keys:

```text
orders.customer_id
        ↓
customers.id
```

and automatically publish:

```ts
references: [{
    field: 'customer_id',
    resource: ['customers'],
    targetField: 'id'
}]
```

That automatically enables:

* clickable references;
* human labels;
* autocomplete;
* `getMany`;
* reverse relationships;
* MCP navigation.

### `@source-repo/document`

Mongo relationships are less declarative, so the package could support explicit catalogue hints where necessary while continuing to distinguish declared from inferred schema. That distinction is already an important design principle in the package. ([GitHub][5])

### OPC UA

OPC UA can publish considerably richer semantic relationships than SQL:

```text
HasComponent
HasProperty
Organizes
HasTypeDefinition
```

Those should not all be flattened into generic tree children.

---

# 4. New `@source-repo/react`

This is the largest missing package IMO.

I would eventually move the reusable parts of `packages/cli/web` out of `rpc-cli`. The CLI package currently owns the browser console alongside CLI and MCP functionality. ([GitHub][6])

The **application** can remain there:

```text
@source-repo/rpc-cli
    source-rpc console
```

but generic React components should become reusable:

```text
@source-repo/react
```

Perhaps:

```text
src/
    hooks/
        useResource.ts
        useList.ts
        useRecord.ts
        useReferences.ts
        useAction.ts
        useTree.ts

    fields/
        StringField.tsx
        NumberField.tsx
        BooleanField.tsx
        DateField.tsx
        ReferenceField.tsx
        MarkdownField.tsx

    inputs/
        StringInput.tsx
        NumberInput.tsx
        BooleanInput.tsx
        EnumInput.tsx
        ReferenceInput.tsx
        ObjectInput.tsx

    resource/
        ResourceList.tsx
        ResourceShow.tsx
        ResourceForm.tsx
        ResourceTable.tsx
        ResourceTree.tsx

    schema/
        fieldForTypeNode.ts
        inputForTypeNode.ts
```

Then:

```tsx
<ResourceList resource={resource} />
```

could work against:

* MongoDB;
* SQL;
* OPC UA;
* Linear;
* Docker;
* PLC model;
* assessment data.

That's the reusable part of React-admin I'd most directly emulate.

### But `@source-repo/react` should not become React-admin

It shouldn't own:

* authentication;
* application routing;
* business workflows;
* application permissions;
* a mandatory layout;
* database CRUD assumptions.

It's a **resource UI toolkit**.

---

# 5. `@source-repo/query` sits underneath React

This package is already deliberately framework-independent and builds TanStack Query caching over `$data`, while using publisher revisions rather than arbitrary `staleTime` assumptions. ([GitHub][7])

So I wouldn't rebuild the React-admin controller cache in `@source-repo/react`.

Instead:

```text
             @source-repo/react
                     │
              React hooks/views
                     │
                     ▼
              @source-repo/query
                     │
          cache/currentness/resources
                     │
                     ▼
               @source-repo/rpc
```

This is considerably cleaner than react-admin's architecture for Source.

The React layer might wrap it:

```ts
const {
    data,
    currentness,
    loading,
    error
} = useResourceList(...)
```

but freshness semantics stay in `query`.

Realtime resource changes should probably also primarily land here because the package already knows how observed component revisions affect cached `$data` results. ([GitHub][7])

---

# 6. New `@source-repo/search`

I think search earns its own package because **federation is an implementation concern, not a primitive RPC feature**.

Core `rpc` could define:

```ts
interface RpcSearchHit {
    target: RpcLocator
    resource?: RpcResource
    representation: string
    kind?: string
    score?: number
    highlights?: RpcSearchHighlight[]
}
```

Individual nodes can expose search capability.

Then:

```text
@source-repo/search
```

does:

```text
query "1202"
      │
      ├── an assessment node
      ├── OPC UA
      ├── Document DB
      ├── Source files
      ├── Linear node
      └── knowledge aspects
             │
             ▼
       merged ranked result
```

The package could support:

```ts
const search = new RpcSearch(client)

const results = await search.find('1202', {
    scope,
    limit: 50
})
```

It should return **Source locators, not URLs**.

Then:

* Console resolves locator → UI;
* MCP resolves locator → context;
* CLI prints it;
* the application layer opens it under the current aspect where possible.

That's worth making a reusable Source capability.

---

# 7. Separate `@source-repo/revisions` from `@source-repo/continuity`

I think this separation is important enough to warrant another package.

`continuity` currently has a very precise job: versioned state snapshots, migrations, obligations, barriers and fenced replacement of running component implementations. ([GitHub][8])

Do **not** turn it into:

> Here is every version ever saved of an assessment document.

That's another concept.

I'd create:

```text
@source-repo/revisions
```

for logical application objects:

```ts
interface Revision<T> {
    id: string
    resource: RpcResource
    recordId: RpcDataId
    createdAt: string
    author?: RpcPrincipal
    value: T
    parent?: string
}
```

Capabilities:

```text
list revisions
get revision
compare revisions
```

and optionally:

```text
restore revision
```

depending on the resource.

### Useful in the application layer

**the assessment application**

```text
the assessment applicationment baseline v4 vs v5
```

**the change-proposal application**

```text
Proposal revision 12 vs 13
```

**Knowledge**

```text
Document before/after engineer review
```

**a control-facing application**

Mostly **display**, not generic restore.

---

# 8. Separate `@source-repo/audit`

I'd also separate audit from revisions.

Because these answer fundamentally different questions:

```text
revisions
"What did it look like?"

audit
"What happened?"
```

A generic audit event could look approximately:

```ts
interface RpcAuditEvent {
    id: string
    at: string

    actor: RpcPrincipal
    action: string

    target?: RpcLocator

    outcome:
        | 'succeeded'
        | 'refused'
        | 'failed'
        | 'unknown'

    correlationId?: string
}
```

This could consume information from existing Source RPC infrastructure rather than inventing another logging mechanism.

An application could enrich it with:

```text
reason
approval
issue
assessment
deployment
evidence
```

But those aren't necessarily universal Source RPC fields.

I see this package becoming the infrastructure beneath the **Continuity log**, rather than putting general audit into `continuity`.

---

# 9. `@source-repo/conformance` becomes increasingly important

As these optional capabilities appear, conformance tests should prevent provider implementations from acquiring subtly different meanings.

For example:

```text
DataProvider conformance
Reference conformance
Tree conformance
Search conformance
Revision conformance
Audit conformance
```

Things like:

> if `representation` says `name`, that field must exist in the declared schema

or:

> a `Reference` target must identify a discoverable resource

or:

> `restore` must never be advertised if unsupported.

This is particularly valuable because `document`, `relational`, `opcua`, `queue`, etc. all independently implement resources.

---

# 10. Saved views/preferences should *not* initially get a Source package

React-admin has preferences and persistent configurable views.

They're useful, but I would keep their **persistence above Source RPC initially**.

Generic type:

```ts
interface ResourceView {
    resource: RpcResource

    columns?: string[]
    filter?: RpcFilter
    sort?: RpcSort[]
    pageSize?: number

    projection?: 'table' | 'tree' | 'cards'
}
```

could live in `@source-repo/react` or potentially core if MCP later benefits from it.

But storage belongs to:

```text
application user preferences
Source Console local settings
customer/team configuration
```

depending on application.

I wouldn't create `@source-repo/preferences` until at least two independent applications need interoperable saved views.

---

# 11. Same for scheduler/calendar

Don't create packages.

Instead allow sufficiently rich semantic fields:

```ts
{
    name: 'plannedStart',
    type: 'date',
    semantic: 'start'
}
```

and:

```ts
{
    name: 'plannedEnd',
    type: 'date',
    semantic: 'end'
}
```

Then a the application layer application can choose:

```text
table
timeline
calendar
Gantt
```

These are **projections**, not RPC protocols.

The portfolio application is the obvious consumer.

---

# 12. Form layout metadata belongs in the resource contract, rendering in React

For simple calls, TypeNode is enough.

For complex forms, it would be useful to support semantic groups:

```ts
presentation: {
    sections: [
        {
            id: 'identity',
            label: 'System identity',
            fields: ['name', 'vendor', 'model']
        },
        {
            id: 'architecture',
            label: 'Architecture',
            fields: ['cpu', 'network', 'io']
        }
    ]
}
```

The group definition probably belongs in `rpc` because:

* React can make an accordion;
* CLI can group questions;
* MCP can understand related arguments;
* another UI can make tabs.

But:

```text
tabs
accordion
two-column
500px
blue
```

does **not** belong there.

That's `@source-repo/react` or application UI.

---

# 13. Which kind of application wants which capability

Above Source packages, I'd distribute the actual Enterprise-style experiences like this:

| Feature | Assessment | Portfolio | Change proposal | Control-facing |
| --- | :---: | :---: | :---: | :---: |
| Generic lists/details      |  ★★★★★ |   ★★★★★  |    ★★★★    |         ★★★         |
| References/relationships   |  ★★★★★ |   ★★★★   |    ★★★★    |         ★★★★        |
| Aspects/navigation context |  ★★★★★ |   ★★★★   |    ★★★★    |         ★★★         |
| Global search              |  ★★★★★ |   ★★★★   |    ★★★★★   |         ★★★★        |
| Saved views                |  ★★★★  |   ★★★★★  |     ★★★    |          ★★         |
| Audit timeline             |  ★★★★★ |   ★★★★   |    ★★★★★   |        ★★★★★        |
| Revision comparison        |  ★★★★  |    ★★    |    ★★★★★   |         ★★★         |
| Forms                      |   ★★★  |    ★★    |    ★★★★★   |         ★★★★        |
| Wizards/sections           |  ★★★★★ |    ★★    |    ★★★★    |          ★★         |
| Realtime                   |   ★★   |    ★★★   |    ★★★★    |        ★★★★★        |
| Advanced tables            |  ★★★★  |   ★★★★★  |     ★★★    |         ★★★         |
| Calendar/timeline          |   ★★   |   ★★★★   |     ★★★    |         ★★★         |
| Generic writes             |   Low  |    Low   | Controlled | **Very restricted** |

This avoids making the Source packages themselves know that "the change-proposal application" exists.

---

## Package dependency picture

I'd aim roughly for:

```text
                    @source-repo/rpc
                           │
          ┌────────────────┼───────────────────┐
          │                │                   │
          ▼                ▼                   ▼
       aspects           query            revisions
          │                │                   │
          │                │                 audit
          │                │
          │                ├────────────┐
          │                │            │
          │                ▼            ▼
          │             react         search
          │                │            │
          └────────────┬───┴────────────┘
                       │
                       ▼
                    rpc-cli
                    console
                       │
             ┌─────────┼──────────┐
             ▼         ▼          ▼
           the assessment application    the portfolio application    the change-proposal application
                                  │
                                  ▼
                                 a control-facing application
```

With provider packages alongside:

```text
document ──────┐
relational ────┤
opcua ─────────┤── publish resources using @source-repo/rpc
docker ────────┤
queue ─────────┤
sparkplug ─────┘
```

The SQL and Mongo packages already intentionally present different backends through the same `$data` contract, rather than introducing new protocols, which is exactly the precedent I'd continue. ([GitHub][5])

### The first implementation batch I would choose

I wouldn't create all the new packages immediately. I'd sequence it:

**Now:** extend `@source-repo/rpc` with **record representation, references, semantic field formats and capability descriptors**. Teach `relational` to derive references from foreign keys. Teach the Console/MCP to consume them.

**Next:** extract reusable Console machinery into **`@source-repo/react`**. Build schema-derived fields, action forms, references and generic list/show/tree views on `@source-repo/query`.

**Then:** introduce **`@source-repo/search`** once at least OPC UA + database + another provider can participate. Search gets much more compelling when it's demonstrably federated.

**Later, driven by change-proposal/the assessment application:** introduce **`@source-repo/revisions`** and **`@source-repo/audit`** separately.

That keeps the package architecture disciplined: react-admin gives Source a large set of proven ideas, but a feature only becomes a Source package when it represents a reusable **system capability**, rather than merely a useful screen.

[1]: https://github.com/source-repo/rpc/tree/main/packages "rpc/packages at main · source-repo/rpc · GitHub"
[2]: https://react-admin-ee.marmelab.com/whats-new "React-Admin Enterprise"
[3]: https://github.com/source-repo/rpc/tree/main/packages/aspects "rpc/packages/aspects at main · source-repo/rpc · GitHub"
[4]: https://github.com/source-repo/rpc/tree/main/packages/relational "rpc/packages/relational at main · source-repo/rpc · GitHub"
[5]: https://github.com/source-repo/rpc/tree/main/packages/document "rpc/packages/document at main · source-repo/rpc · GitHub"
[6]: https://github.com/source-repo/rpc/tree/main/packages/cli "rpc/packages/cli at main · source-repo/rpc · GitHub"
[7]: https://github.com/source-repo/rpc/tree/main/packages/query "rpc/packages/query at main · source-repo/rpc · GitHub"
[8]: https://github.com/source-repo/rpc/tree/main/packages/continuity "rpc/packages/continuity at main · source-repo/rpc · GitHub"
