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
9/2/2026, 3:20:13 PM

Theres also the enterprise additions https://react-admin-ee.marmelab.com/whats-new

## Response:
9/2/2026, 3:20:19 PM

Yes — the enterprise layer is probably even more relevant to the applications than the core CRUD pieces, because it adds the “large operational system” concerns: workflows, permissions, auditability, collaboration, configurable views, and richer relationship handling. I’ll separate genuinely transferable concepts from features that are too tied to back-office SaaS.

> **Searching the web**
>
> [ra-audit-log@latest Documentation](https://react-admin-ee.marmelab.com/documentation/ra-audit-log)
>
> **Prioritizing additions**
>
> I’m mapping the listed modules onto the database engine’s core needs. Search, relationships, audit history, locking, schema-driven forms, soft deletion, and context navigation seem most conceptually relevant; AI and scheduling appear more peripheral.
>
> **Designing capability layers**
>
> I’m separating operational capabilities from the core data interface. A discoverable capability description could cover browsing, writing, search, history, audit, realtime changes, locking, references, trees, and lifecycle states without bloating the provider contract.
>
> **Prioritized additions and designed capability layers**
>
> 
>
> **Searched 1 website**
>
> 
>
> Worked for 49s

Yes. Looking through the current Enterprise Edition changes the picture somewhat. The open-source react-admin layer is mainly a good model for **generic resource interaction**; the enterprise additions are a good catalogue of the **cross-cutting capabilities that appear once the resource system becomes large and operational**.

That second category is highly relevant to the applications.

The most important architectural lesson I take from it is that Source probably shouldn't keep extending `DataProvider` itself every time one of these needs appears. Instead, resources could expose **discoverable optional capabilities**.

Conceptually:

```ts
interface ResourceDescription<Row> {
    path: RpcResource;
    row: TypeNode<Row>;

    capabilities: {
        list?: ListCapability<Row>;
        tree?: TreeCapability<Row>;
        relations?: RelationsCapability<Row>;
        revisions?: RevisionCapability<Row>;
        audit?: AuditCapability;
        realtime?: RealtimeCapability<Row>;
        locking?: LockCapability;
        search?: SearchCapability;
        lifecycle?: LifecycleCapability;
    };

    presentation?: ResourcePresentation<Row>;
}
```

Not necessarily this exact TypeScript structure, but I increasingly like the idea of **resource capabilities** as the abstraction.

React-admin EE effectively arrived at this by adding separate DataProvider extensions for trees, revisions, realtime, search, soft delete, etc. Source can make that pattern explicit and strongly typed from the beginning.

## The EE features I'd rank highest for Source

| Enterprise feature | Source relevance | Main the application layer use |
|---|---:|---|
| **History / revisions / diff** | ★★★★★ | the change-proposal application, knowledge, assessment baselines |
| **Audit log** | ★★★★★ | All the applications, Continuity |
| **Global search** | ★★★★★ | Knowledge system, the assessment application, Source Console |
| **Relationships** | ★★★★★ | Knowledge graph, assets, documents, OPC UA |
| **Realtime** | ★★★★★ | a control-facing application, simulation, collaboration |
| **Navigation/AppLocation** | ★★★★★ | Aspects, changing contexts, multi-system browsing |
| **RBAC** | ★★★★★ | application permission projections |
| **Headless Core** | ★★★★★ | Source React UI architecture |
| **JSON Schema forms** | ★★★★☆ | Source TypeNode-derived forms |
| **Advanced grid** | ★★★★☆ | the portfolio application, the assessment application, console |
| **Tree** | ★★★★☆ | Source already has a better foundation |
| **Editable grid** | ★★★☆☆ | Knowledge/config, carefully |
| **Form layouts/wizards** | ★★★☆☆ | assessment intake, the change-proposal application |
| **Soft delete** | ★★★☆☆ | Knowledge/docs/issues, not industrial actions |
| **Scheduler/calendar** | ★★☆☆☆ | Maintenance/planning views |
| **Markdown** | ★★☆☆☆ | Knowledge documents |
| **AI form helpers** | ★★☆☆☆ | Some application UI, but not Source semantics |
| **Tours** | ★☆☆☆☆ | Product UX only |

There are several particularly strong ideas among these.

---

## 1. History and Audit Log are *two different things*

This distinction is very relevant to the applications.

React-admin EE has a **History** module that stores revisions, shows differences between versions, and can revert to an earlier version. Separately, its **Audit Log** represents user actions as events and supplies timelines for the application and individual records. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-history))

That maps almost perfectly onto two concepts Source should keep distinct:

```text
Revision history
"What did this object look like?"

Audit/continuity history
"What happened, who/what caused it, and why?"
```

For example:

```text
Motor specification P-104
─────────────────────────
Revision 17
  setpoint: 1450 → 1500
  ramp:     12s  → 15s
```

versus:

```text
2026-09-02 13:42
Jane approved proposal ST-224

2026-09-02 13:48
a control-facing application deployed revision 17

2026-09-02 13:49
TwinCAT build succeeded

2026-09-02 13:53
Commissioning test T-84 passed
```

These absolutely should not be collapsed into one generic "history".

For **the change-proposal application**, the EE History pattern-revision list → diff → potentially restore-is an excellent model. React-admin even provides field-by-field and word-level diffing. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-history))

But Source should be stricter about the meaning of **revert**.

A knowledge document:

```text
revert revision 17 → 15
```

is reasonable.

A PLC:

```text
revert current state
```

is not a generic resource operation.

So revision capability might expose:

```ts
{
    canCompare: true,
    canRestore: false
}
```

depending on the resource.

This fits the the change-proposal application → a control-facing application separation very nicely.

---

## 2. Global Search is extremely relevant

The EE Search module provides an omnibox that searches across resources rather than requiring the user to know first whether something is an `artist`, `track`, etc. It adds a generic `dataProvider.search(query)` operation. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-search))

For the application layer, this is much more important than it sounds.

Imagine typing:

```text
1202
```

and getting:

```text
Alarm             AL-1202 Communication timeout
PLC symbol        FB_Comms.Error1202
Document section  Recovery procedure / Alarm 1202
Issue             "Intermittent alarm 1202 on Line 4"
the assessment applicationment        Finding AF-91
Source code       CommHandler.ts:281
```

That becomes the natural entry point into the entire knowledge system.

And because Source RPC peers can span systems:

```text
             Global Source Search

      ┌──────── an assessment database
      ├──────── Source code
query ┼──────── Linear
      ├──────── OPC UA
      ├──────── PLC symbols
      └──────── documents
```

This relates directly to the idea we've discussed of the database/context changing as you browse.

But I wouldn't return browser URLs as react-admin does. I would return a **semantic Source locator**:

```ts
interface SearchHit {
    locator: RpcLocator;
    representation: string;
    resource: RpcResource;
    kind?: string;
    highlights?: SearchHighlight[];
}
```

Then browser, CLI and MCP can all resolve the same result.

That feels like an important Source RPC feature.

---

# 3. Navigation's `AppLocation` is surprisingly relevant to aspects

One EE feature I had underestimated is `ra-navigation`.

It deliberately separates **application location from browser URL**. A resource can therefore appear inside a logical structure such as:

```text
Customers / Volvo / Orders / 1234
```

even if that isn't simply a reflection of URL hierarchy. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-navigation))

This is very close to what we've been discussing around Source aspects.

The same underlying object might be reached as:

```text
Functional
  / Cooling
      / Pump P-104
```

or:

```text
Location
  / Factory 1
      / Building B
          / Floor 2
              / Pump P-104
```

or:

```text
Product
  / Pump systems
      / Pump P-104
```

or perhaps:

```text
Knowledge
  / the assessment applicationment 2026
      / Finding AF-19
          / Pump P-104
```

The **resource identity hasn't changed**, but its application/navigation location has.

That's almost exactly the point of their `AppLocation`.

I therefore think Source should explicitly distinguish:

```text
identity       = what object/resource this is
locator        = how to reach it
navigation path = how it appears in this projection/aspect
```

This becomes particularly useful when a user's current context includes:

- an aspect;
- a current Source peer;
- a database context;
- a Linear account;
- perhaps a plant/site;
- an assessment.

We already arrived at that need independently. React-admin EE is useful evidence that separating application context from transport/browser addressing works well in practice.

---

# 4. Relationships reinforce the reference idea

Their Relationships module handles richer relations, especially many-to-many relationships through an intermediate resource. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-relationships))

This reinforces my earlier suggestion that **relations deserve first-class semantics in Source**.

But I would generalize beyond database relationships.

Source could support something resembling:

```ts
type RelationKind =
    | 'reference'
    | 'contains'
    | 'containedBy'
    | 'related'
    | 'implements'
    | 'evidenceFor'
    | 'derivedFrom';
```

Not necessarily those exact verbs as core RPC types-but conceptually.

A Source relation could connect:

```text
the assessment applicationment finding
      │ evidenceFor
      ▼
Source code function

Function
      │ implements
      ▼
Plant behaviour

Behaviour
      │ affects
      ▼
Physical asset
```

Now the generic resource infrastructure is starting to become the basis for the the knowledge system graph.

Importantly, **tree edges and relationship edges are different**.

That's something to preserve.

---

# 5. Realtime maps very naturally onto Source RPC

React-admin EE's realtime package adds publish/subscribe, live updates, notifications, and record locks to its otherwise request/response DataProvider model. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-realtime))

Source doesn't need to copy that transport mechanism because **props, state, observables and events already exist**.

Instead the useful idea is the higher-level semantic operation:

```text
"This collection changed."
"This row changed."
"This row disappeared."
"This user is editing it."
```

A generic Source viewer shouldn't have to poll.

Something like:

```text
DataProvider
    │
    ├── snapshot queries
    │
    └── change stream
             ↓
      generic list/tree
```

would be valuable.

For example an OPC UA tree could update:

```text
P-104
  running       true → false
  speed         1450 → 0
  alarm         false → true
```

without turning every individual field into bespoke application code.

And this also works for Linear, databases, Docker, simulation and logs.

---

# 6. Locks are useful, but I'd call the Source concept something stronger

React-admin provides record locking to prevent two users simultaneously editing a record; its UI can say that another user has locked the record. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-realtime))

Useful inspiration, but The applications have several distinct concepts:

```text
collaborative edit lock
        ≠
execution lease
        ≠
authorization
        ≠
industrial control authority
```

For the change-proposal application:

> Anders is currently editing this proposal.

A normal edit lock is fine.

For A control-facing application:

> This engineering session currently holds authority to perform deployment operations.

That's closer to a **lease/capability/authority token** than a database lock.

So I'd borrow the UX but resist implementing a universal `lock(resource,id)` concept and pretending it covers everything.

---

# 7. JSON Schema Form validates the TypeNode direction

Their JSON Schema Form module generates forms directly from a schema rather than explicitly specifying each input. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-json-schema-form))

That's exactly what I suggested Source should do with TypeNode.

But Source has an advantage.

React-admin has:

```text
TypeScript interface
     ??
JSON Schema
     ↓
form
```

Source can potentially have:

```text
TypeScript
   ↓
RPC TypeNode
   ├── validation
   ├── serialization
   ├── MCP schema
   ├── documentation
   └── form
```

One definition propagates through the entire system.

I would definitely study their schema-form behavior-nested objects, arrays, optional values, validation, enums, custom widgets-but **not introduce JSON Schema as another canonical type system** just because react-admin uses it.

TypeNode should remain authoritative if it can express what Source needs.

---

# 8. Datagrid AG has lots of useful UX ideas

The enterprise AG Grid wrapper supports resizing and reordering columns, pinning, advanced filters, virtualization, keyboard navigation, editing, grouping, aggregation, tree data, master/detail, context menus and other large-dataset features. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-datagrid-ag))

For **the portfolio application**, that's especially interesting.

Consider:

```text
System         Risk   Age    Findings   Downtime   Status
─────────────────────────────────────────────────────────
Packing PLC    8.7    17 y      14        23 h     Review
Boiler PLC     7.1    12 y       8         9 h     Review
HVAC           4.2     8 y       3         2 h     Good
```

Then the user can:

- group by plant/system/vendor;
- pin risk and name;
- filter;
- aggregate;
- save the resulting view;
- export.

This might mean Source's generic viewer eventually should use something like AG Grid rather than growing its own enormous table implementation.

But that's a UI/library decision, not an RPC design decision.

Interesting detail: react-admin has to translate AG Grid's typed filter concepts back into its loosely specified DataProvider filter format. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-datagrid-ag))

Source's explicit `RpcFilterOp` model is cleaner here.

---

# 9. Preferences become much more important with aspects

React-admin's preference system persisted things like filters, selected grid columns, language, sidebar state and theme. Most of this eventually migrated into its open-source Store abstraction. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-preferences))

For Source I'd think of this as:

```text
Resource defaults             supplied by peer
             +
Aspect defaults               supplied by projection
             +
Application defaults          supplied by the application layer
             +
User preferences              supplied by user
             ↓
Effective view
```

For example:

```text
OPC UA resource says:
  default columns = BrowseName, NodeClass

the application layer OPC aspect says:
  add Value, Quality

User says:
  move Quality left
  hide NodeClass
```

That layering seems worth designing intentionally.

---

# 10. RBAC supports another idea we've discussed: permission as a projection

React-admin EE can express permissions at resource and even field/UI-action level, while explicitly warning that client-side visibility is not security and checks must also exist on the server. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-rbac))

The applications need exactly that distinction:

```text
RPC authorization
      ↓
authoritative

Capability projection
      ↓
what UI/MCP is told it may attempt
```

So the Source Console shouldn't blindly display every discovered method and then let them fail.

The peer can provide an **effective capability projection for the current principal**:

```ts
{
    canRead: true,
    canWrite: false,
    actions: ['inspect', 'diagnose']
}
```

Then:

- human UI gets sensible buttons;
- MCP doesn't even advertise irrelevant operations;
- authoritative `authorize()` still checks every actual invocation.

For the application layer this is much more important than conventional RBAC UI.

---

# 11. Soft Delete suggests a generic resource lifecycle

Their new Soft Delete package has explicit operations for archive/delete, browse deleted records, restore and permanently delete them. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-soft-delete))

I don't think Source RPC needs all of these as universal DataProvider methods.

But the broader concept of a **resource lifecycle** is good:

```text
active
archived
superseded
deleted
```

That could be very useful for:

- documents;
- assessment findings;
- knowledge items;
- the change-proposal application proposals;
- issues;
- saved views.

It would be actively misleading for many control-facing resources.

You don't "soft delete Pump P-104".

So again this argues for optional resource capabilities rather than an ever-growing universal DataProvider.

---

# 12. Form layouts are useful for assessment and change-proposal work

Enterprise adds accordion and wizard-style forms for complex data entry. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-form-layout))

This makes me think about **assessment intake sessions**.

Instead of a giant auto-generated object editor:

```text
[ 67 fields ... ]
```

the semantic schema might allow grouping:

```text
System identity
   ↓
Architecture
   ↓
Operational history
   ↓
Known problems
   ↓
Maintenance
   ↓
Documentation
   ↓
Review
```

This is presentation semantics rather than data semantics.

So TypeNode alone isn't quite sufficient to produce a *good* complex form. There probably needs to be optional semantic structure above it.

Maybe:

```ts
presentation: {
    sections: [
        {
            label: 'Architecture',
            fields: [...]
        }
    ]
}
```

This doesn't violate the earlier rule against pixel/layout details. `"Architecture"` as a semantic group has meaning independently of React.

That could also benefit MCP: it can ask logically grouped questions.

---

# 13. Scheduler and Calendar are less fundamental, but potentially useful

The Calendar handles events and recurring events; Scheduler goes much further into assignments, constraints, dependencies, resources and nested events. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-calendar))

I wouldn't put scheduling into Source RPC core.

But if a resource exposes:

```ts
{
    start: Date,
    end: Date,
    resource: ...
}
```

then it's another **projection** that can be selected automatically.

For the portfolio application:

```text
planned shutdowns
maintenance
assessment activities
modernization programme
```

For A control-facing application:

```text
test sequence execution
commissioning schedule
```

This is a good example of the knowledge-system idea that a resource doesn't have one natural UI.

Same records:

```text
table aspect
calendar aspect
timeline aspect
dependency aspect
```

---

# 14. Markdown is interesting mostly as a type/presentation hint

The EE Markdown package essentially adds display and editing components for Markdown content. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-markdown))

This suggests TypeNode/presentation semantics should be able to distinguish:

```ts
string
```

from:

```ts
string + semantic format "markdown"
```

Likewise:

```text
plain string
markdown
source code / language=typescript
URL
email
duration
unit-bearing number
IEC identifier
```

The underlying TypeScript type may still just be `string`, but the **semantic format** significantly changes how generic viewers should render it.

This is another area where Source could be more rigorous than react-admin.

---

# 15. The AI module is interesting mainly as a counterexample

Their AI package provides text completion, rewriting and form filling, with LLM calls exposed as additional DataProvider operations. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-ai))

For ordinary back-office software, reasonable.

For the application layer, I would deliberately **not** make AI just another invisible input enhancement.

We've already reached the principle that the user should know when they have crossed into AI behavior, particularly anywhere near the control-system domain.

So:

```text
AI-generated value
```

should not become indistinguishable from:

```text
deterministically derived value
```

The Source MCP architecture gives us a much cleaner separation anyway.

AI is a **client/actor of Source**, rather than magical behavior embedded throughout Source resources.

That remains a significant architectural advantage.

---

# An important emerging pattern

After looking at both core react-admin and EE, I think there are actually **four layers**, rather than the three I proposed before:

```text
┌─────────────────────────────────────────────┐
│ 4. Viewer/application                      │
│ React views, tables, diagrams, calendar    │
│ user preferences, widths, layout           │
├─────────────────────────────────────────────┤
│ 3. Presentation semantics                  │
│ labels, representation, sections, formats  │
│ default columns, suggested view            │
├─────────────────────────────────────────────┤
│ 2. Resource capabilities                   │
│ list, tree, relations, revisions, audit    │
│ realtime, search, lifecycle, locking       │
├─────────────────────────────────────────────┤
│ 1. RPC semantics                           │
│ types, methods, props/state/events          │
│ auth, command semantics, errors            │
└─────────────────────────────────────────────┘
```

React-admin tends to mix 2-4 because it's an application framework.

**Source should explicitly separate them.**

That's perhaps the most useful architectural conclusion from studying react-admin EE.

## And it fits the different kinds of application remarkably well

```text
                         Source resource model
                                  │
             ┌────────────────────┼────────────────────┐
             │                    │                    │
          the assessment application               the portfolio application              the change-proposal application
       browse/evidence       projections/KPIs      revisions/edit
       relationships         saved views           diff/workflow
       search/history        aggregation           collaboration
             │                    │                    │
             └────────────────────┼────────────────────┘
                                  │
                                a control-facing application
                            realtime/actions
                           authority/audit
                                  │
                                  ▼
                            Source Console
                                  +
                                 MCP
```

So yes, I would add the Enterprise Edition documentation to the reference set.

And three EE ideas now stand out to me as especially important enough to influence **Source RPC itself**, rather than merely application UI:

**First, resource capabilities.** Don't make `DataProvider` grow into a 40-method interface; let introspection tell clients that this resource supports `tree`, `history`, `search`, `realtime`, etc.

**Second, semantic navigation location.** React-admin's distinction between browser location and `AppLocation` maps remarkably well onto Source aspects, contextual databases/accounts, and alternative projections of the same underlying object. ([React-Admin Enterprise Edition](https://react-admin-ee.marmelab.com/documentation/ra-navigation))

**Third, global semantic search.** A Source-level search result pointing to a resolvable Source locator could make the whole distributed RPC/knowledge network feel like one system instead of a collection of adapters.

Those three feel worth considering fairly early, because unlike calendar views or fancy grids, **they affect the shape of the model rather than just the UI built on top of it**.

---

**Sources:**

- [ra-history@latest Documentation](https://react-admin-ee.marmelab.com/documentation/ra-history)

---
Powered by [ChatGPT Exporter](https://www.chatgptexporter.com)