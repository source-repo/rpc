# Source RPC General Knowledge System Extensions — Design Specification

*Status: proposed design, 2026-08-29. The central decision is to build an optional knowledge provider layer over Source RPC, not to turn every Source RPC node into a knowledge-management object. Linear is the first validation adapter and is specified separately.*

## 1. Executive decision

Source RPC can provide an unusually strong foundation for a general knowledge system. It already has stable identities, typed contracts, observable props and state, collection resources, paging, filtering, row actions, topology, authorization, lifecycle, browser tooling and MCP exposure.

There is nevertheless a real risk of creating a monster. A Source RPC node already has many responsibilities, and adding documents, arbitrary graphs, layout definitions, search indexing, external synchronization and executable examples directly to the node contract would make the core difficult to explain, implement in other languages and trust on constrained systems.

The proposal therefore follows one rule:

> Source RPC transports and governs knowledge capabilities; an optional knowledge provider owns
> knowledge semantics. An ordinary Source RPC node gains nothing and changes nothing.

The design should proceed, subject to the following boundary:

- `@source-repo/rpc` receives at most two small wire-contract extensions: lazy tree retrieval for the resource shape it already advertises, and an optional list of default column paths. Richer row-action forms reuse existing action and method descriptions and require no new action schema.
- `@source-repo/knowledge` owns knowledge identities, relationships, structural projections, contextual links, view/edit activation intent and content blocks.
- Adapters such as `@source-repo/linear` map external systems into that knowledge contract.
- The CLI web console owns presentation and a safe renderer registry. Nodes describe data and presentation intent; they never send executable UI code.
- Canonical knowledge remains independent of RPC, MCP and any particular viewer. Those are access and presentation surfaces, not the data model's source of truth.

This is not Source RPC becoming Obsidian, Jupyter, Linear and a UI framework. It is Source RPC making a separately implemented knowledge provider discoverable, secure and uniformly browsable.

## 2. Purpose

This specification defines the minimum extensions and the optional package architecture required to use Source RPC as the access plane for heterogeneous organisational and technical knowledge, including:

- Business, product, marketing, web and development descriptions
- Control-system design, deployment, functional and security knowledge
- Markdown and other text content
- Declarative UI artefacts
- Static code and explicitly sandboxed live examples
- Links whose destination includes the desired viewing context
- Multiple structural projections over the same underlying objects
- Mixed informational and executable resources in one browser
- Lazy virtual trees, search, filtering, paging and row actions
- Safe MCP access to the same capabilities

The model emerged from work on an assessment product, and the requirement it took from that work is a general one: it must remain useful outside any single product, and it must not make a product's canonical model dependent on RPC. A knowledge provider is an access surface over a canonical model that continues to exist without it.

## 3. Architectural constraints

The following constraints are normative.

1. **Ordinary nodes stay ordinary.** A device, queue or service that does not implement the knowledge capability publishes no knowledge metadata and pays no runtime or conceptual cost.
2. **Knowledge items are not RPC instances.** Ten thousand issues or documents are ten thousand virtual resources behind a provider, not ten thousand peers, components or worker threads.
3. **Stable identity is independent of every tree.** Reorganising a projection never changes an object's reference. Paths are display context, never foreign keys.
4. **Runtime topology retains its meaning.** Source RPC's physical `parent` and logical `owner` edges carry runtime placement, ownership, fencing and inherited context semantics. Knowledge projections—including a security view—must not be added as arbitrary topology axes.
5. **A projection is a read model, not authority.** Appearing under an authorised-looking branch grants nothing. Runtime authorization continues to be decided by Source RPC security policy.
6. **Links carry intent, never privilege.** A link may request a projection and focus, but cannot reveal or authorize an otherwise inaccessible target.
7. **No remotely supplied UI code.** Renderers are locally installed and allowlisted. Unknown artefacts fall back to a safe representation.
8. **No general expression language in the core.** Providers implement projections and queries. Source RPC carries bounded request values; it does not evaluate remotely supplied graph rules, JavaScript, regular expressions or GraphQL.
9. **Live examples are explicit capabilities.** Markdown cannot quietly execute. A live example references a separately declared sandboxed method or runtime.
10. **MCP is one doorway.** The same provider is usable by the console, typed Source RPC clients and MCP; no knowledge feature may exist only as an MCP tool.
11. **Placement must not change value semantics.** Same-thread, worker, process and remote providers exchange the same portable value domain. Shared mutable state is not a knowledge-system feature. This constraint is no longer only a rule: `valueRefusal` in `packages/rpc/src/RPC/Value.ts` checks a value against what *every* placement carries, so a knowledge object holding a `Date`, a class instance or a cycle is refused with its path named rather than arriving flattened at one placement and intact at another. A provider gets this by being an ordinary component; it does not implement it.

## 4. Goals

- Browse heterogeneous knowledge through a consistent tree-and-list interface
- Present the same object through several meaningful structures without duplicating it
- Preserve a user's viewing projection when following links where that projection remains valid
- Support documents and executable components in the same information space without pretending that they have identical behaviour
- Let a higher-level view choose whether row activation opens view or edit without making activation itself a command
- Derive generic tables and filters from existing Source RPC type descriptions
- Let a provider choose useful default columns without defining an entire UI
- Scale to external collections through lazy children, server-side filters and paging
- Make external adapters independently installable and independently permissioned
- Expose the same bounded read model through MCP
- Preserve evidence, provenance, freshness and external identity
- Allow future writes only as explicit Source RPC methods with declared effects and semantics

## 5. Non-goals

- Replacing any product's canonical model with an RPC graph
- Making every Source RPC node a document, graph node or UI plugin
- Turning `RpcComponent.state` into a document database
- Adding arbitrary axes to runtime topology or context inheritance
- Defining a universal ontology for all business and engineering domains
- Remotely loading React components, JavaScript bundles, HTML or CSS from a node
- Running code merely because it appears in Markdown
- Providing a generic remote GraphQL, SQL, JavaScript or graph-query console
- Recreating every feature of Linear, Obsidian, Notion or Jupyter
- Treating search results or AI summaries as verified evidence
- Making worker threads correspond one-to-one with virtual knowledge items
- Giving MCP broader access than an equivalent authenticated human client

## 6. Existing Source RPC foundations and actual gaps

The design is intentionally close to what current Source RPC already provides.

| Concern | Existing foundation | Missing seam |
|---|---|---|
| Stable executable identity | `RpcRef { peer, instance }` | A stable reference for a row/object behind a provider |
| Runtime structures | Physical `parent` and logical `owner` topology | Any number of non-authoritative knowledge projections |
| Typed current values | Component props/state and schema | Long-form content and heterogeneous object summaries |
| Narrow live views | Per-subscriber snapshot projection | Projection as an alternate structural view; the term must remain distinct |
| Collections | `RpcDataResources`, `$data`, row schemas, filters, sort and paging | Lazy child retrieval for `shape: 'tree'` |
| Columns | A resource already publishes its row `TypeNode` | Optional default column paths only |
| Row operations | Declared actions map rows to existing RPC methods | Reuse the typed method form when an action has further arguments; no resource-schema change |
| Row activation | Component and row values already have generic presentations | Optional view/edit affordances selected by projection, workspace or user mode |
| Virtual nodes | Store-backed resources already avoid one component per row | Projection occurrences and contextual navigation |
| Browser | Scope tree, value grid, search/filter/paging and actions | Knowledge detail panel and allowlisted block renderers |
| Security | Authentication, authorization, effects, idempotency and AI grants | Provider-level row/field filtering without existence leakage |
| Writes | `RpcWriteVerb`, `RpcWritePermissions`, `RpcWriteOutcome` and `rowStamp` in `DataWrites.ts` | Nothing. An adapter's mutations reuse this vocabulary rather than inventing one |
| MCP | Discovery, describe, component reads and data browsing | Knowledge-oriented convenience tools over the same provider |

Current `RpcDataResource` already declares a row type, verbs, label, actions and `shape?: 'list' | 'tree'`; its source notes that branch-by-branch tree retrieval is not yet served. That unimplemented declaration is the natural extension point, not evidence that another parallel collection system is needed.

## 7. Package and responsibility boundaries

Native stores and external adapters feed a knowledge provider. Source RPC transports and governs that provider's capability; the console, applications and MCP consume the same contract.

### 7.1 `@source-repo/rpc`

The core continues to own transport-independent mechanics:

- Typed method and event contracts
- Authentication, authorization, effects and delivery semantics
- Components, snapshots and narrow data projections
- `$data` list and tree transport
- Introspection of resource row shapes and existing row actions
- Portable value validation
- The vocabulary a write is spelled in: verbs, permission documents, outcomes and the row stamp

It does not learn what a document, issue, projection, Markdown block or knowledge link means.

### 7.2 `@source-repo/knowledge`

The optional package owns:

- Knowledge references and object summaries
- Typed relationships
- Projection descriptors and occurrences
- Projection-aware link resolution
- Content block descriptors
- Provider interfaces and a reusable provider base class
- Optional composition across several providers
- Provider fixtures contributed to `packages/conformance`, which is where the questions live

### 7.3 Provider adapters

An adapter maps a native source without leaking its API into the general model. Examples include:

- `@source-repo/linear`
- A native Source Document provider
- A Git repository provider
- A Source RPC network provider that represents executable peers and components informationally
- A provider over a product's own canonical model, where that product wants its knowledge browsable

An adapter may be read-through, cached or backed by a local index. That is an implementation choice reported through provider state, not a difference in the public knowledge contract.

### 7.4 CLI web console

The console owns:

- Projection selection and history
- Tree occurrences and breadcrumbs
- Generic grid/list presentation
- Document and Markdown rendering
- Renderer registration and safe fallback
- User-specific view preferences

It must not become a second authority or store canonical object edits implicitly.

### 7.5 Versioning

This workspace versions `rpc`, `rpc-cli`, `sparkplug`, `relational`, `document` and `conformance` together, because a package that tracks an unstable interface is easier to reason about pinned to the version it was built against. `packages/queue` is deliberately outside that rule, since it depends only on the public API and exists to prove the schema compatibility policy holds for an external consumer.

`@source-repo/knowledge` joins the lockstep, because it is the package asking for the two core extensions and is meaningless against a library that lacks them. `@source-repo/linear` does not: it depends only on the knowledge contract and the public API, and pinning an adapter to the library's number would un-prove the thing the adapter is built to prove—that a provider can be installed and removed without the core moving. That makes the Linear adapter the second package after `queue` to carry its own number, and for the same reason.

## 8. Terminology

| Term | Meaning |
|---|---|
| **Knowledge provider** | One Source RPC component serving objects and projections from one bounded source or composition |
| **Knowledge object** | A stable informational identity with summary, fields, optional content and links |
| **Knowledge reference** | Provider plus resource and object id; independent of projection and path |
| **Relationship** | A typed directed edge between knowledge references |
| **Knowledge projection** | A named structural read model over objects and relationships |
| **Occurrence** | One appearance of an object or virtual grouping node inside one projection |
| **Location** | Projection, occurrence and optional focus used to display a target |
| **Navigation intent** | The projection/focus/fallback requested by a link |
| **Content block** | A bounded declarative unit such as Markdown, code or an artefact reference |
| **Virtual node** | A lazily returned projection occurrence; not an RPC component or execution context |
| **Executable binding** | Optional reference from an informational object to an existing RPC capability |

`KnowledgeProjection` must never be abbreviated to `RpcProjection` in code. Source RPC already uses that term for narrowing a component snapshot on the wire, and the two operations are unrelated.

## 9. Identity and object model

### 9.1 Stable references

```ts
import type { RpcRef } from '@source-repo/rpc'

export interface KnowledgeRef {
  /** The component that can resolve this object. */
  provider: RpcRef

  /** Provider-defined resource name, not a structural path. */
  resource: readonly string[]

  /** Stable native or generated id inside that resource. */
  id: string
}
```

The provider and resource identify the authority for resolving the id. If two providers believe their objects represent the same real thing, they publish an `equivalent-to` relationship; the system does not silently merge identities.

### 9.2 Object summary and detail

```ts
export interface KnowledgeOrigin {
  system: string
  externalId?: string
  url?: string
  createdAt?: string
  updatedAt?: string
  retrievedAt?: string
  revision?: string
}

export interface KnowledgeObjectSummary {
  ref: KnowledgeRef
  /** Namespaced, such as linear.issue or source.rpc-component. */
  kind: string
  title: string
  summary?: string
  icon?: string
  fields?: Readonly<Record<string, unknown>>
  origin: KnowledgeOrigin
}

export interface KnowledgeObject extends KnowledgeObjectSummary {
  content?: readonly KnowledgeBlock[]
  links?: readonly KnowledgeLink[]
}
```

All values must be inside the canonical portable Source RPC value domain. A provider may publish a more specific TypeScript type and extracted schema, but generic clients can always read the common summary.

The summary is deliberately small enough for tree and grid rows. Full Markdown, comments, source and artefacts arrive only when the object is opened.

### 9.3 Relationships

```ts
export interface KnowledgeRelationship {
  id: string
  from: KnowledgeRef
  to: KnowledgeRef
  /** Namespaced or provider-owned, such as linear.project-issue. */
  kind: string
  label?: string
  origin?: KnowledgeOrigin
}
```

Relationships are facts in the provider model. A hierarchy is one possible reading of those facts, not the facts themselves.

## 10. Content blocks and artefacts

The initial block vocabulary is intentionally small.

```ts
export type KnowledgeBlock =
  | {
      kind: 'markdown'
      id: string
      markdown: string
      source?: KnowledgeOrigin
    }
  | {
      kind: 'code'
      id: string
      language?: string
      code: string
      source?: KnowledgeOrigin
    }
  | {
      kind: 'attachment'
      id: string
      label: string
      mediaType?: string
      href: string
      source?: KnowledgeOrigin
    }
  | {
      kind: 'artefact'
      id: string
      /** Namespaced renderer id installed in the viewer. */
      renderer: string
      value: unknown
      fallback?: 'json' | 'markdown' | 'link'
    }
  | {
      kind: 'live-example'
      id: string
      label: string
      capability: {
        target: RpcRef
        method: string
      }
      input?: unknown
      sandbox: 'required'
    }
```

Rules:

- Markdown is rendered through an HTML-disabled or sanitized renderer.
- `artefact.renderer` selects only locally registered code. It is a hint, not a module URL.
- Unknown renderers use the declared safe fallback.
- A `live-example` is inert until the user explicitly runs it.
- The target method is described and authorized like any other RPC call. A viewer must display its effect and semantics before execution.
- The runtime must advertise a sandboxed execution profile. `sandbox: 'required'` cannot degrade to running in the console or supervisor process.
- Live examples are not part of the first implementation phase.

## 11. Structural projections

### 11.1 Why projections are separate from topology

Source RPC topology has two deliberately strong meanings:

- `parent`: physical placement
- `owner`: logical ownership/scope

Those edges participate in runtime fencing and inherited context. A general knowledge system needs many more views—functional, security, business, product, process, dependency, evidence and work—but those are interpretations. Giving them topology semantics would make a view capable of changing authorization or runtime ownership, which is unacceptable.

A security projection may show zones, trust boundaries, identities and exposed capabilities. It is still a read model. Security enforcement remains in the Source RPC authorization layer and the underlying systems.

### 11.2 Provider-executed projections

```ts
export interface KnowledgeProjectionDescriptor {
  id: string
  label: string
  description?: string
  revision: string
  default?: boolean
  preferredPresentation?: 'tree-list' | 'list' | 'board' | 'document' | 'graph'
  /** A higher-level hint; user/workspace choice takes precedence. */
  preferredActivation?: 'view' | 'edit'
}

export type KnowledgeViewIntent =
  | { kind: 'none' }
  | { kind: 'object'; focus?: string }
  | {
      kind: 'component'
      target: RpcRef
      section?: 'values' | 'methods' | 'data' | 'source'
    }
  | { kind: 'method'; target: RpcRef; method: string }
  | { kind: 'block'; blockId: string }
  | { kind: 'link'; linkId: string }

export type KnowledgeEditIntent =
  | { kind: 'none' }
  | { kind: 'method'; target: RpcRef; method: string }
  | { kind: 'link'; linkId: string }

export interface KnowledgeActivationAffordances {
  view?: KnowledgeViewIntent
  edit?: KnowledgeEditIntent
}

export interface KnowledgeOccurrence {
  /** Identity of this appearance, not of the underlying object. */
  occurrenceId: string
  ref?: KnowledgeRef
  /** Virtual grouping nodes have no ref and cannot be opened as canonical objects. */
  virtual?: {
    kind: string
    key: string
  }
  title: string
  kind: string
  relation?: string
  hasChildren: boolean
  fields?: Readonly<Record<string, unknown>>
  /** Destinations the row supports; a higher-level view chooses which mode activation opens. */
  activation?: KnowledgeActivationAffordances
}
```

The provider supplies roots and children. The protocol does not initially publish a generic rule language for constructing projections. This permits projections backed by Linear relationships, database joins, computed security zones or code, without making Source RPC evaluate an open-ended query language.

The same object may appear several times in one projection and in many projections. Therefore:

- `KnowledgeRef` identifies the object.
- `occurrenceId` identifies one displayed placement.
- A breadcrumb consists of occurrence ids and labels.
- A saved link never treats a breadcrumb as the object's identity.

### 11.3 View/edit affordances and higher-level activation

A row can advertise two destinations: **view** and **edit**. It does not decide which one a normal click or Enter opens. That choice belongs to the higher-level interaction context, using this precedence:

1. An explicit temporary user mode or explicit View/Edit control
2. Saved user or workspace preference
3. The current projection's `preferredActivation` hint
4. Safe default: `view`

If edit is selected but the row offers no authorized edit affordance, the viewer falls back visibly to view. A virtual grouping node always scopes/expands rather than entering edit mode.

When no affordances are declared, the viewer derives these defaults:

| Occurrence | View | Edit |
|---|---|---|
| Virtual grouping node | Select/expand it and scope the adjacent list | None |
| Knowledge object | Open generic object detail | None |
| Executable RPC component | Open `component` section `values`, with full authorized props and state | None unless explicitly advertised |
| Ordinary non-knowledge resource row | Open the complete schema-derived row view | None unless an existing write capability is bound |

A provider may choose another bounded view, such as component methods, data resources or source, a particular content block, a contextual link, or an existing observe method. A method-backed view must be described as `observe`, accept the row id as its only required argument and return a portable described result. Access checks still apply; naming `source` does not grant diagnostics permission.

A method-backed edit opens the console's typed argument form with the row id prefilled and locked as argument zero. It does **not** invoke the method until the user explicitly saves/calls. The method must have described remaining input, and its effect, authorization, confirmation, idempotency and unknown-outcome semantics remain intact. An edit link may instead open a separately authorized editor, including an external application's editor.

`block` rendering uses only locally installed renderers. An unknown or unavailable destination falls back to generic object/row detail and reports the fallback. A provider cannot embed UI code, manufacture hidden method arguments or make a single activation immediately commit a write.

“Full props and state” describes the presentation, not an instruction to transfer an unbounded snapshot. Typed scalar leaves can remain observed while declared collections continue to use their paged resources, as the current console already does.

### 11.4 Candidate projections

The model is intentionally open-ended. Likely providers include:

- Physical/deployment
- Logical ownership
- Functional structure
- Process or material flow
- Security zones and trust relationships
- Product composition
- Business objective and value chain
- Evidence and assessment coverage
- Work planning and current execution
- Dependencies

No provider is required to implement any particular projection name.

## 12. Projection-aware links

### 12.1 Link shape

```ts
export interface KnowledgeLink {
  id: string
  label?: string
  relation?: string
  target: KnowledgeRef
  navigation?: KnowledgeNavigationIntent
}

export interface KnowledgeNavigationIntent {
  /** Default: inherit the source location's projection. */
  projection?: 'inherit' | { id: string }

  /** Optional block, field or renderer-defined focus inside the target. */
  focus?: string

  /** Used when the requested projection cannot place the target. */
  fallback?: 'target-default' | 'canonical' | 'refuse'

  /** Optional occurrence whose neighbourhood should be preferred. */
  near?: string
}

export interface KnowledgeLocation {
  target: KnowledgeRef
  projectionId?: string
  occurrenceId?: string
  focus?: string
  inherited: boolean
  fallbackUsed?: 'target-default' | 'canonical'
}
```

### 12.2 Resolution algorithm

When following a link:

1. Authorize access to the target before revealing whether it exists.
2. If the link names a projection, attempt that projection.
3. Otherwise inherit the source location's projection.
4. If the target occurs more than once, prefer the occurrence nearest `near`, then the occurrence sharing the longest visible ancestor chain with the source.
5. If the projection cannot place the target, apply the link's fallback; default to `target-default`.
6. Apply `focus` only after the target object and chosen renderer are authorized.
7. Return the resolved location and whether fallback occurred so the UI never silently changes context.

A link stores navigation intent rather than a materialized path. Projections can change revision, and retaining an obsolete path would create a convincing but false context.

### 12.3 External links

Plain HTTP links remain ordinary content links. If an adapter recognizes one as an entity it owns, it may additionally publish a typed `KnowledgeLink`. The original Markdown or URL must remain available as source evidence.

## 13. Resource and query protocol

### 13.1 Provider capability

Knowledge providers advertise a package-qualified capability such as:

```ts
export interface KnowledgeProviderCapability {
  protocolVersion: 1
  supports: {
    objectDetail: true
    search: boolean
    projections: boolean
    liveExamples: boolean
    writes: boolean
  }
  limits: {
    maxPageSize: number
    maxSearchText: number
    maxContentBytes: number
    maxLinkCount: number
  }
}
```

Capability discovery uses the existing Source RPC extracted-contract mechanism. It must not depend on class names, which do not survive every build.

### 13.2 Data resources

A provider should expose:

- A list resource for object summaries, if global listing/search is supported
- A list resource for projection descriptors
- One dynamic or declared tree resource per projection
- Optional kind-specific resources such as issues or documents

Object details and link resolution are ordinary typed query methods. Mutations, when present, are ordinary explicitly named methods—and they are spelled in the vocabulary `DataWrites.ts` already defines: `RpcWriteVerb` for what may be done to a row, `RpcWritePermissions` for how permission is written down, `RpcWriteOutcome` for what comes back, and `rowStamp` for whether a row has changed. That file states the reason a provider must not invent its own: if two nodes each computed a stamp, they would disagree about whether a row had changed while both of their suites stayed green. A knowledge adapter is a second such node, so it inherits the constraint rather than the exemption.

The first provider may use this representative interface:

```ts
export interface KnowledgeProvider {
  capabilities(): Promise<KnowledgeProviderCapability>
  getObject(ref: KnowledgeRef): Promise<KnowledgeObject>
  resolveLink(
    link: KnowledgeLink,
    source?: KnowledgeLocation
  ): Promise<KnowledgeLocation>
  search?(request: KnowledgeSearchRequest): Promise<KnowledgeSearchResult>
}
```

No `executeQuery(text)` or `graphql(query)` method is permitted.

### 13.3 Minimal `$data` extensions

The existing resource contract should be completed rather than replaced.

```ts
export type RpcDataMethod =
  | 'getList'
  | 'getOne'
  | 'getMany'
  | 'getManyReference'
  | 'getChildren'

export interface RpcGetChildrenParams extends RpcGetListParams {
  /** Absent means projection roots. */
  parentId?: string
}

export interface RpcGetChildrenResult extends RpcGetListResult {
  /** Positionally matches ids/data without modifying the provider's row model. */
  hasChildren: readonly boolean[]
}
```

The usual bounds, authorization, timing, epoch/revision and optional resource stamp apply. Filtering and sorting are evaluated before paging among one parent's children.

The exact verb name is subject to implementation review, but the semantics are not: roots and each branch are fetched independently and pageably.

The positional `hasChildren` array is the shape `RpcGetListResult.ids` already has, and for the reason given there: a row may be a primitive, and merging a field into it would either be impossible or quietly overwrite a field the row already had. Following the existing precedent matters more than the small ugliness of two arrays read together.

### 13.4 Columns without a UI schema explosion

The possible columns of a resource already follow from `RpcDataResource.row`. A second declaration of possible columns would drift from the schema and should not be added.

Only the provider's preferred initial subset is missing:

```ts
export interface RpcDataPresentationHint {
  /** Dot paths into the declared row type. Unknown paths are ignored and diagnosed. */
  defaultColumns?: readonly string[]
}

export interface RpcDataResource {
  // existing fields...
  presentation?: RpcDataPresentationHint
}
```

Rules:

- All schema-derived fields remain selectable.
- An absent hint lets the viewer derive a compact default from the row shape.
- Labels, types and filterability come from the schema, not from the hint.
- Widths, colours, breakpoints and React component names are user/viewer preferences.
- Computed columns must be real published row fields or a locally installed viewer feature.

The same derivation applies to props and state: their extracted types define possible leaves; the viewer chooses a compact default representation.

### 13.5 Row actions and the existing argument form

`RpcDataResource.actions` remains the one declaration of default row buttons. No knowledge-specific action model, toolbar grammar or remotely supplied form schema is added.

Row activation is not an implicit first action. It resolves the occurrence's advertised view/edit affordances using the higher-level interaction mode. Edit may open a method form, but only an explicit Save/Call invokes it; row-tail buttons remain explicit actions.

The current action contract says that the row id is passed to the named method. That convention can be extended safely in the viewer without changing `RpcDataAction`:

1. The selected row id binds to the method's first argument.
2. If that is the method's only argument, the button retains today's direct invocation behaviour.
3. If the described method has further arguments, the button opens the console's existing typed argument form with argument zero prefilled and locked to the row id. The user supplies the remaining arguments before invoking it.
4. A multi-argument action is not drawn unless introspection describes its parameter types and its first parameter accepts the resource's string id. A configuration diagnostic names the invalid action instead of leaving a button that can only fail.
5. `action.confirm` requests confirmation, and a method declared `non-repeatable-command` requires the console's normal armed confirmation. The stronger requirement wins.
6. Authorization, effect, deadline, idempotency key and unknown-outcome handling remain properties of the invoked RPC method. Button metadata cannot weaken or replace them.
7. After a settled call, the viewer invalidates the resource that declared the action rather than assuming a local mutation result.

Implementation should extract the reusable argument editor/invocation surface from `MethodPanel` and allow a prefix of arguments to be bound. It must not duplicate its coercion, optional-argument, preset or confirmation logic in the grid.

Providers must not publish arbitrary argument templates or executable button handlers. If a real case eventually needs a row value other than the id to be bound, that requirement should be proved before adding explicit, closed binding metadata.

### 13.6 Search

Structured filters continue to use the closed `$data` filter vocabulary. Full-text or relevance search is an optional bounded provider method because relevance, stemming and external API support are source-specific.

```ts
export interface KnowledgeSearchRequest {
  text: string
  projectionId?: string
  withinOccurrenceId?: string
  kinds?: readonly string[]
  pageSize?: number
  cursor?: string
}

export interface KnowledgeSearchResult {
  matches: readonly KnowledgeObjectSummary[]
  nextCursor?: string
  tookMs?: number
}
```

Search results are leads, not evidence. The object detail retains provenance and source links.

## 14. Console presentation

The default knowledge workspace reuses the existing console mechanics:

- Left: provider and projection selector plus a lazy occurrence tree
- Centre: filtered, searchable and paged list for the selected scope
- Right or main detail pane: selected object's content, fields, relationships and actions

The tree scopes the list; it does not force every click to replace the entire page. Activating an object resolves its view/edit affordances under the current projection, workspace and user mode. Selecting a virtual grouping node filters to the objects beneath it. Keyboard and pointer activation must resolve the same mode and intent.

The viewer should support these built-in safe renderers initially:

- Generic fields/table
- Sanitized Markdown
- Static code with syntax highlighting
- Attachment/link
- JSON fallback

Diagram, flow and other domain-specific artefact renderers register locally under namespaced renderer ids. The object can request one, but cannot provide its implementation.

View preferences—chosen columns, widths, sort, layout and expanded branches—belong to the user or workspace presentation store. They are not domain state and should not be written into every node.

## 15. Mixed executable and informational objects

The system must allow an informational object to describe or link to an executable component without collapsing the distinction.

```ts
export interface KnowledgeExecutableBinding {
  target: RpcRef
  relationship: 'describes' | 'implements' | 'operates' | 'tests' | string
}
```

When a bound component is selected, the console may compose:

- Knowledge content from the provider
- Live props/state from the component
- Declared RPC methods and effects
- Data resources and row actions
- Diagnostics, source or other separately advertised capabilities

The knowledge provider adds context; it does not proxy or duplicate the component's authority. Calls go directly to the declared RPC capability under the caller's normal authorization.

## 16. Security model

### 16.1 Layered authorization

Source RPC authorization still checks the method and parameters. A knowledge provider must also enforce data-dependent rules before forming an answer:

- Object visibility
- Relationship visibility
- Projection occurrence visibility
- Field/block redaction
- Search result visibility

Filtering occurs at the provider, never only in the browser. If policy requires hiding existence, an inaccessible reference resolves as not found rather than forbidden.

### 16.2 Projection safety

A projection must be filtered as a graph, not merely filtered row by row after traversal. Otherwise an inaccessible ancestor, child count or relationship label can disclose structure.

Providers must define one of these behaviours for a hidden branch:

- Omit it entirely
- Replace it with an explicit opaque boundary where policy permits revealing that a boundary exists

The default is omission.

### 16.3 Actions and AI

- Informational reads have effect `observe`.
- Every change is an explicitly named method with declared repeatability and effect.
- A row action adds no power; it maps a row id to the first argument of an existing method and may open the same typed argument form used when invoking that method elsewhere.
- The viewer must not manufacture hidden arguments or bypass the method's confirmation semantics.
- MCP exposes only what the Source RPC identity and AI grants permit.
- A navigation link never carries credentials, grants or an authority token.
- `live-example` execution requires a separately granted programming capability and an approved sandbox.

### 16.4 Credentials

External-system credentials stay inside the adapter host. They never appear in props, state, knowledge objects, browser storage, links or MCP results.

## 17. Freshness, revisions and provenance

Every provider publishes operational state separately from knowledge objects:

```ts
export interface KnowledgeProviderState {
  status: 'initializing' | 'live' | 'stale' | 'degraded' | 'offline'
  epoch: string
  revision: number
  lastSuccessfulReadAt?: string
  lastExternalEventAt?: string
  problem?: string
}
```

Object origin identifies when the external source changed and when it was retrieved. The provider's component revision identifies the current cached view. Those are different facts and must not be collapsed.

Rules:

- A stale object remains readable with visible stale status.
- A provider restart changes epoch.
- A projection descriptor carries its own revision so saved locations can detect restructuring.
- Webhooks or events invalidate/cache-refresh; they are not automatically treated as canonical full objects.
- External removals produce tombstones long enough to resolve old links honestly.
- AI summaries, extracted links and inferred relationships identify their derivation and never overwrite source-authored content silently.

## 18. Federation and composition

The first implementation may browse one provider at a time. Later composition can present several providers in one projection, but it must remain optional.

A composing provider:

- Holds references to source providers rather than copying their identity
- Applies its own authorization in addition to each source provider's authorization
- May add relationships and projection occurrences
- Does not claim ownership of underlying content
- Reports unresolved or stale source providers explicitly
- Bounds fan-out, depth, result size and time

Cross-provider equivalence remains a relationship, not automatic object merging.

## 19. Execution placement and virtual nodes

Knowledge items are passive values. They run nowhere.

The provider component may be placed:

- In the supervisor thread for ordinary I/O-bound adapters
- In a worker for CPU-heavy indexing or diagnostics isolation
- In another process for failure, credential or security isolation
- On a remote peer near the authoritative store

Placement does not change the contract. Same-thread providers must not expose live object references that a worker would clone. `SharedArrayBuffer` is reserved for explicit infrastructure protocols, not shared knowledge or component state.

One worker per virtual document or issue is prohibited by design. A worker belongs to an active provider or executable component, never to each row it serves.

## 20. Delivery phases

### Phase 0 — Prove value without core expansion

- Implement the read-only Linear provider on current Source RPC mechanisms
- Expose list resources, schemas, Markdown detail and external links
- Use current table search/filter/paging
- Add knowledge-specific UI only where generic rendering is insufficient
- Record every pressure to modify core rather than satisfying it immediately

This phase answers whether the use case is valuable before generalising it.

### Phase 1 — Minimal reusable knowledge package

- Introduce `KnowledgeRef`, object summaries/details and content blocks
- Advertise the knowledge provider capability
- Implement provider-owned named projections
- Implement projection-aware link resolution
- Add conformance fixtures

### Phase 2 — Complete generic resource support

- Add lazy `getChildren` for resources already declaring `shape: 'tree'`
- Add optional `presentation.defaultColumns`
- Add the occurrence tree to the console
- Reuse the console's typed method invocation form for multi-argument row actions
- Confirm no ordinary node API changes beyond the optional fields/verb

### Phase 3 — Composition and richer built-in presentation

- Cross-provider links and optional composing provider
- Saved user/workspace presentation preferences
- Allowlisted domain-specific artefact renderers
- Evidence and provenance panels

### Phase 4 — Explicit writes and live examples

- Add adapter-specific mutations only where a real workflow justifies them
- Add sandbox capability and explicit run UX for live examples
- Keep writes and execution out of the generic content model

Each phase must be independently useful. A later phase is not justification for shipping unused abstraction in an earlier one.

## 21. Acceptance criteria

The general design is accepted when all of the following hold:

1. A normal existing Source RPC component compiles and behaves without implementing or importing the knowledge package.
2. One provider can expose at least 100,000 virtual objects without creating a component, peer or worker for each object.
3. The same object can appear in at least three projections while retaining one `KnowledgeRef`.
4. A link with no explicit projection inherits the current projection when the target occurs there.
5. Fallback is visible when inheritance cannot place the target.
6. Tree roots and branches are fetched independently with paging and bounded filters.
7. Generic possible columns derive from the row schema; the provider declares only defaults.
8. View mode opens an executable occurrence's authorized props/state by default; edit mode opens an editor only when advertised, and activation itself never commits a command. A virtual group only scopes/expands.
9. A row action with further parameters opens the normal typed method form with only the row id prebound; invoking it retains the method's authorization, effect and command semantics.
10. Unknown artefact renderers execute no remote code and display a safe fallback.
11. Markdown cannot invoke a method or execute code without an explicit user action.
12. An inaccessible object is absent from tree, list, search, links and MCP results consistently.
13. A security projection cannot grant runtime authority or alter topology fencing.
14. An informational object can bind to a live RPC component without proxying its authority.
15. Provider stale/offline status remains visible while cached objects remain readable.
16. The console and MCP reach the same provider contract and enforce the same authorization.
17. The Linear adapter can be removed without changing Source RPC core or native knowledge objects.

## 22. Anti-monster review gates

Every proposed addition must answer these questions before adoption:

1. Is this useful to at least one non-knowledge Source RPC resource?
2. Can it live in `@source-repo/knowledge` or the console instead of `@source-repo/rpc`?
3. Does it duplicate information already present in the extracted schema or introspection?
4. Does it add capability, or merely presentation intent?
5. Can an ordinary C#, constrained or embedded implementation ignore it cleanly?
6. Does it introduce a remotely supplied expression or executable language?
7. Does it accidentally give a read model authority semantics?
8. Is the first Linear use case blocked without it, or is it speculative?
9. Is this truly an explicit operation, or merely a view/edit destination that row activation can open without committing?

If the answer to question 8 is “speculative,” the feature remains outside the implementation.

## 23. Rejected alternatives

### Make every knowledge object an `RpcComponent`

Rejected because object count would become runtime count, presence would become enormous, external rows would acquire false executable identity and worker/lifecycle semantics would become absurd.

### Generalise Source RPC topology to unlimited named axes

Rejected because topology axes already carry runtime inheritance and fencing meaning. Knowledge views must be numerous and cheap to change; runtime ownership must be sparse and difficult to change.

### Store presentation JSON on every node

Rejected because row schemas already define possible fields and viewer preferences are not domain state. Only a small default-column hint is needed.

### Add a second action or form-description language

Rejected because `RpcDataAction` already identifies the method and the described method already contains parameter names, types, effects and command semantics. The row id can bind its existing first argument and the console can reuse its existing argument form for the remainder.

### Make row click invoke a default RPC method

Rejected because selection is easy to trigger accidentally and navigation must be safe to repeat. The row may advertise bounded view and edit destinations, but edit activation only opens its form; effectful submission remains explicit and row-tail methods remain visibly separate actions.

### Send React components or JavaScript from providers

Rejected because it turns browsing an authenticated node into code installation. Renderer ids are descriptors resolved against locally installed implementations.

### Adopt Linear's GraphQL model as the general model

Rejected because Linear is a test adapter, not the architecture. Its concepts map to namespaced kinds and relationships; they do not define Source knowledge identity or projection semantics.

### Build a universal declarative projection DSL first

Rejected because its requirements are unknown and its evaluator would become a second query engine. Provider-executed projections test the contract before any rule language is considered.

## 24. Implementation decision summary

Proceed with a general knowledge capability, but keep it visibly layered:

- **Source RPC:** transport, contracts, security, lifecycle and bounded collection mechanics
- **Source Knowledge:** objects, relationships, projections, contextual links, view/edit affordances and content blocks
- **Adapters:** mapping, credentials, caching and external synchronization
- **Console:** presentation and locally installed renderers
- **MCP:** an authorized projection of the same capabilities

This division makes the existing richness an advantage rather than an excuse to make every node responsible for everything.

## 25. References

- [Source RPC `RpcDataResource` and tree declaration](https://github.com/source-repo/rpc/blob/39de1b86a4780cdc578c5842d623575969e62a86/packages/rpc/src/RPC/DataProvider.ts#L248-L347)
- [Source RPC topology semantics](https://github.com/source-repo/rpc/blob/39de1b86a4780cdc578c5842d623575969e62a86/packages/rpc/src/RPC/Topology.ts#L3-L40)
- [Source RPC structural context axes](https://github.com/source-repo/rpc/blob/39de1b86a4780cdc578c5842d623575969e62a86/packages/rpc/src/RPC/Context.ts#L5-L46)
- [Source RPC introspection of component resources](https://github.com/source-repo/rpc/blob/39de1b86a4780cdc578c5842d623575969e62a86/packages/rpc/src/RPC/Introspection.ts#L65-L88)

## 26. Review against the implementation, 2026-08-30

Read against the tree at `6ff699a`. The design is sound and should proceed. What follows is what was checked, what changed, and the one question this review cannot answer.

### What held

The central claim is not merely plausible, it is what the code already says. `RpcDataResource.shape` exists and its own comment reads: *a tree is fetched a branch at a time and is not served yet; it is named here so a resource that is one can say so rather than be mistaken for a list that happens to be long.* The seam this specification asks to complete is a seam the library declared and deliberately left open. That is the difference between an extension and an addition.

The row-action proposal in §13.5 reaches a conclusion `DataProvider.ts` had already reached independently: *each is called with the row's id and nothing else, and anything richer is a form rather than an action.* Binding argument zero and drawing the remainder with the console's existing typed form is that sentence implemented rather than contradicted.

`RpcRef`, the closed filter vocabulary `RpcFilterOp`, introspection carrying each resource's row shape, and `MethodPanel` in `packages/cli/web/src` are all real and as described. The two extensions asked for—lazy children and a default-column hint—are absent, as assumed.

### What changed

**Writes now reuse the vocabulary that exists.** The specifications discussed mutations without reference to `DataWrites.ts`, which already defines the write verbs, the permission document, the outcome and `rowStamp`. The Linear draft returned a `LinearIssueRevision` of its own, which is precisely what that file exists to prevent: two nodes each inventing a stamp disagree about whether a row changed while both of their suites stay green. §13.2, §6, §7.1 and the Linear §18 now inherit that vocabulary. This was the one place where the design would have grown a private convention where the repository already had a public one.

**Conformance fixtures moved.** `@source-repo/knowledge` was to own conformance tests for providers. This repository's rule is that the questions live in `packages/conformance` and a new store-backed node adds a column to that comparison rather than a suite of its own—which is the same argument this specification makes about not duplicating the schema.

**A versioning position was taken.** Every package here either joins the lockstep or is deliberately outside it, and neither specification said which. §7.5 now argues that knowledge joins and Linear does not, on the grounds that pinning an adapter to the library's number would un-prove exactly what the adapter exists to demonstrate.

**`RpcValue` now backs constraint 11.** Placement-independent value semantics was stated as a rule to follow; since `b630d1a` it is enforced by `valueRefusal`, and a provider inherits it by being an ordinary component.

**The positional `hasChildren` array was justified rather than defended.** It is the shape `RpcGetListResult.ids` already has, for the reason given there.

Both files were also unwrapped to one line per paragraph, this repository's markdown convention, while their wording was left untouched.

### What was decided about publishing this

An earlier draft of these specifications named the products the discussion had emerged from, and this review raised that as a question to settle before committing to a public repository. It was settled by removing them: the design does not depend on any of them, and naming the room a general idea was first argued in is not the same as the idea needing that room.

What remains is the requirement rather than the customer—an access surface over knowledge that keeps its own canonical model. That is a stronger statement of the design and a shorter one, which is usually the sign that the specific name was doing no work.

Where `@source-repo/knowledge` and `@source-repo/linear` should eventually live is still open, and is the question `packages/sparkplug` left open too. Publishing the reasoning does not decide the packaging, and nothing here needs it decided yet.
