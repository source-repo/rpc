# A network scope over DataProvider resources

## Goal

Use the existing scope-tree, leaf-grid and optional preview arrangement at the top of the RPC
network. Selecting the network, a peer, a component, one of its resources or a provider-owned
branch scopes the same grid to every leaf beneath that selection.

The hierarchy is:

```text
network
└─ peer
   ├─ Interfaces
   │  ├─ RPC namespace (branch record)
   │  │  └─ method leaves
   │  └─ Transports
   │     └─ transport leaves
   └─ RpcComponent
      ├─ props
      ├─ state
      └─ declared resources
         └─ provider-defined branches
            └─ leaf rows
```

A leaf is decided by the resource, not by whether its value is structurally simple. A scalar can
be a leaf, but so can an object such as an RPC component's props or state, a row of a SQL table, an
OPC UA node or a document. The tree is for scoping; it does not dictate the shape of a value.

## Boundaries

This work reuses the existing view. It does not introduce a second `NetworkScopeView` rendering.
The network-level catalogue and composite provider feed the existing scope-tree/leaf-grid
arrangement. Events remain chronological UI in the contextual panel. Network-wide chronological
tools—traffic, problems, presence and operations—are full main workspaces reached from the left
menu. Method declarations are
stable, inspectable records, so the peer's synthetic `interfaces` resource exposes RPC namespaces
as branches and their methods as leaves. A method leaf is marked `rpc.method`; its Call row action
opens the existing typed call form in the contextual panel and invocation remains an ordinary RPC
call rather than a DataProvider verb. The same resource exposes the peer's RPC transports beneath
a Transports branch. These are descriptive `rpc.transport` leaves rather than actions: protocol,
role and a credential-free public endpoint come from `describe()`, not from console inference.

The first implementation is client-side. A server-side aggregator would call other peers under the
aggregator's authority rather than the reader's authority and would silently change the security
meaning of every read. The browser already has the correct peer identity and can ask each provider
directly.

The console's primary workspace and its default for provider data is the scope-tree/value-grid
arrangement, including a component that serves only flat list resources. Flatness means the scope
has no provider-owned children; it is not a reason to switch renderers. The left column is
console-level navigation (Network plus network-wide diagnostics), not a second peer tree. Other list-like UI
remains appropriate only when it is not provider data—for example event and presence history,
operations, problems, chat and chronological traffic—or when a resource later declares semantics
the generic grid cannot truthfully represent.

Global offset pagination over a changing collection of independent providers is deliberately not
part of the first cut. The bounded implementation reports partial results and omits totals it does
not know. A distributed continuation cursor can follow after the model has been exercised.

## Provider contract used by the view

The network composition does not define a second DataProvider interface. Its normative input is
`RpcDataResources` from `@source-repo/rpc`: `dataResources()` declares each resource and
`dataRequest()` answers exactly the verbs it declares. The method-to-parameter-to-result mapping is
`RpcDataContract`.

For this view the capability profiles are precise:

- a flat resource needs `getList`;
- a tree needs `shape: 'tree'`, `getChildren` for branch discovery, and `getList` with
  `under`/`recursive` for the leaf grid;
- preview is optional and uses `getOne` when its detail is richer, otherwise `getMany([id])`;
- `getManyReference`, row actions and writes are separately advertised extensions.

`row` remains optional on the wire for compatibility, but it is the useful minimum for a generic
view: without it the viewer can show a fallback value but cannot truthfully derive columns and
field-aware behavior.

## Identity

Paths and labels describe placement. They are not identity: reparenting or relabelling a node must
not invalidate selections, cached rows or links.

```ts
type ScopeRef =
    | { kind: 'network' }
    | { kind: 'peer'; peer: string }
    | { kind: 'component'; peer: string; namespace: string }
    | { kind: 'resource'; peer: string; namespace: string; resource: readonly string[] }
    | { kind: 'branch'; peer: string; namespace: string; resource: readonly string[]; id: string }

interface RowLocator {
    peer: string
    namespace: string
    resource: readonly string[]
    id: string
}
```

The locator is also the row key. Two tables may both have row `1`, and two components may both have
a `state`; neither collision is exceptional when the full address is retained.

## Scope catalogue

Extract a renderer-independent catalogue from the current component-local scope helpers:

```ts
interface ScopeCatalogue {
    roots(): readonly ScopeNode[]
    children(scope: ScopeRef): Promise<readonly ScopeNode[]>
    resourcesUnder(scope: ScopeRef): Promise<readonly ResourceLocator[]>
}
```

Its inputs are existing facts:

- `peers()` supplies network membership.
- `describe(peer)` supplies components, capabilities, types and declared resources.
- host and component topology supply placement;
- component contracts supply `props` and `state` structure;
- namespace descriptions supply the peer-level `interfaces` tree and its method leaves;
- declared providers supply other resources;
- tree-shaped providers supply their deeper branches lazily with `getChildren`.

Provider declarations are authoritative. Contract traversal supplies the default for ordinary
component props and state. Unresolved topology, cycles and refused descriptions remain visible
rather than being dropped.

## Composite provider

Build a client-side `NetworkDataProvider` over the catalogue, existing `$data` calls and the shared
`RpcDataCache`:

```ts
interface NetworkDataProvider {
    getChildren(scope: ScopeRef): Promise<ScopeChildren>
    getList(scope: ScopeRef, params: NetworkListParams): Promise<NetworkListResult>
    getOne(locator: RowLocator): Promise<RpcGetOneResult>
}
```

For a selected scope, `getList` resolves descendant resources, asks each resource, merges answers
in stable catalogue order and keeps the origin on every row. A refusal or unavailable peer is
carried beside successful results and does not erase them.

Reuse the current query cache for deduplication, freshness and targeted invalidation, and reuse the
bounded fan-out already used by search and peer description.

## Heterogeneous rows

Rows retain their source and their original type:

```ts
interface ScopedRow {
    locator: RowLocator
    source: {
        peer: string
        namespace: string
        resource: readonly string[]
        interfaces: readonly string[]
    }
    value: unknown
    type?: TypeNode
    representation?: string
}
```

A single homogeneous resource keeps its declared `defaultColumns`. An aggregate scope adds only
the context needed to distinguish its rows, such as peer, component, resource, path, kind and id,
then derives data columns from the union of declared row fields. Cell rendering uses each row's own
`TypeNode`; it does not infer a common type from samples. Scalars use a `value` column and objects
remain valid single rows.

Selecting a row uses its locator and opens the existing optional preview/detail panel. The source's
declaration chooses the read: `getOne` for richer detail, otherwise `getMany([id])` for providers
whose list and detail row have the same shape.

A branch may also carry a record. Its identity and display label stay separate from that value: an
interface namespace branch, for example, has a name, version, implementation class and capabilities.
The network adapter preserves this record while the tree uses only its label. The generic
scope-summary section above the grid shows the selected branch record; it requires no
resource-specific rendering and does not confuse that branch with one of its leaves.

## Filtering and search

Network filtering has two stages.

Structural predicates prune providers before any row request:

- peer;
- component or namespace;
- implemented interface/capability;
- resource name or kind;
- topology placement;
- aspect or arrangement.

Row predicates are sent to the providers that remain. A public vocabulary can distinguish them:

```text
source.peer
source.namespace
source.interface
source.resource
row.kind
row.<field>
```

The composite provider evaluates `source.*` itself and translates `row.*` to the existing
`RpcFilter`. A field absent from a resource's declared row type cannot match that resource. Search
reuses `@source-repo/search`, and a hit selects its containing scope and row instead of opening a
separate presentation path.

Implemented capability names remain structural metadata on components and their resources, so they
can prune provider requests. In addition, every described peer exposes a synthetic `interfaces`
tree from the same `describe()` answer. RPC namespaces are rich branches; methods are leaves with
named parameter schemas, rest and return schemas, semantics, effect, state path and authority facts.
Arguments are fields of the method record rather than leaves: a zero-argument method must remain
visible, and an argument has no useful identity independent of the method that accepts it.

## Bounded first implementation

The first implementation may fan out because the network is expected to be limited, but it must be
honest about its bounds:

- bound concurrent descriptions and data calls;
- bound resources and rows included in one answer;
- keep successful rows when another source fails;
- return per-source refusals and `partial: true` when incomplete;
- omit `total` unless it is genuinely known;
- never present the number fetched as the network total.

Later pagination should be a continuation cursor carrying per-provider positions and merge state,
not a global offset that independent changing providers cannot honour.

## Delivery order

1. Define stable scope identities and a pure network scope catalogue, with tests.
2. Implement the client-side composite provider over `describe()` and `$data`.
3. Adapt the existing scope-tree/leaf-grid components to accept network scopes.
4. Normalize heterogeneous rows and connect the existing row preview.
5. Add partial-result reporting and bounded fan-out.
6. Add structural interface/capability filtering and row filtering.
7. Reuse federated search and add deterministic aggregate sorting.
8. Make the network scope the primary console workspace and remove the duplicated peer/detail flow.
9. Keep selection-bound tools in the contextual right panel and network-wide destinations in the left menu.
10. Verify component-level parity, deep links, watch views, writes and actions.

## Implementation status

Completed on `feature/network-scope-data-provider`:

- stable scope and row identities, including unresolved and cyclic topology;
- the pure catalogue for peers, components, props, state and declared resources;
- bounded client-side composition through the browser's existing `RpcDataCache` authority;
- the adapter into the existing `ValueGrid`, `ResourceTree`, `BranchTable` and `RecordPanel`;
- provider-owned tree branches and recursive leaf scoping;
- declared-field promotion for heterogeneous rows, with scalar fallback and existing preview;
- visible per-source refusals and bounded-result status;
- structural `peer`, `namespace`, `resource` and `interface` filters combined with provider row filters;
- provider-side row sorting plus deterministic sorting of the bounded aggregate;
- the network DataProvider as the always-mounted primary console workspace;
- a navigation-only left menu for Network, Traffic, Problems, Presence and Operations instead of
  the duplicate PEERS topology;
- scope propagation from the generic tree into right-side event/chat context and Traffic's optional
  selected-peer filter;
- removal of the bespoke node resource preview from the main console flow;
- one consistent scope-tree/value-grid layout for ordinary component resources, including
  components that expose only flat list resources such as depot Stock.
- `props` and `state` as built-in tree-shaped DataProvider resources: their catalogue entries are
  published by `describe()`, branches come from `getChildren`, scoped leaves from recursive
  `getList`, and the console no longer builds a separate schema tree for Line-style components.
- a peer-level `interfaces` tree answered locally from `describe()`: RPC namespaces are metadata-rich
  branches, methods are leaves, interface filtering becomes a row predicate for this resource, and
  method preview needs no extra network request;
- preservation of provider branch records through the network adapter and a generic scope-summary
  section above the value grid; peers, RPC components, interface namespaces and provider-defined
  objects use the same path.
- a Call action only on `rpc.method` leaves, resolving the aggregate row identity back to its peer,
  namespace and method and opening the existing typed call form; the duplicated all-methods panel
  is no longer a second method catalogue.

Still deferred:

- distributed continuation cursors and exact pagination across independent providers;
- federated text search that selects a containing scope and row;
- write parity and deep-link persistence;
- deciding whether child-node facts need a separate synthetic leaf resource in addition to their
  structural role;
- moving saved Watch scopes into the unified navigation model.

## First vertical slice

The first usable slice is deliberately narrow:

1. draw network → peer → component → resource in the existing scope tree;
2. select a component or peer;
3. resolve its `props`, `state` and flat declared resources;
4. ask their first bounded pages;
5. show contextualized rows in the existing grid;
6. open one row through the existing preview.

Tree-shaped provider resources, network filters and distributed continuation follow after this path
works end to end.

## Acceptance

- Selecting the network root shows leaves from more than one peer.
- Selecting a peer, component or resource narrows the same grid.
- Component props, state and declared resources are all reachable.
- A resource remains authoritative about which of its values are leaves.
- SQL rows and component values coexist without identity collisions.
- Interface filtering asks only matching components.
- A selected row opens its provider's detail answer where available.
- An offline or unauthorized peer does not erase other results.
- Incomplete aggregation is visibly partial.
- Reads retain the browser peer's existing authority.
- Relabelling or reparenting topology does not change identities.
