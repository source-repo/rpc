---
title: Data providers
topics: components, data, collections, trees
---

# Data providers

A component snapshot is the small, current summary somebody watches. A DataProvider is the other
half: collections somebody asks to filter, sort and page once. A SQL table, a document collection,
an address space and a component's own `props` and `state` all use the same `$data` protocol.

This page is the implementer-facing contract. **Must** means a provider has to do it for the answer
to mean what the protocol says. **Should** describes the useful generic-viewer profile. **May** is
an advertised capability: omit its verb or metadata when it cannot be implemented truthfully.

## The interface

A component serving its own resources implements both methods of `RpcDataProvider`. The older name
`RpcDataResources` is an exact compatibility alias for the same interface.

```ts
import {
    RpcComponent,
    type RpcDataMethod,
    type RpcDataParams,
    type RpcDataResource,
    type RpcDataProvider,
    type RpcDataResult
} from '@source-repo/rpc'

class Catalogue extends RpcComponent<Props, State> implements RpcDataProvider {
    dataResources(): readonly RpcDataResource[] {
        return [{
            path: ['products'],
            verbs: ['getList', 'getOne', 'getMany'],
            row: {
                kind: 'object',
                fields: {
                    name: { type: { kind: 'string' } },
                    price: { type: { kind: 'number' } }
                }
            },
            presentation: {
                defaultColumns: ['name', 'price'],
                representation: 'name'
            }
        }]
    }

    async dataRequest(
        method: RpcDataMethod,
        resource: readonly string[],
        params: RpcDataParams
    ): Promise<RpcDataResult> {
        // Dispatch only the paths and verbs declared above, then return the
        // corresponding RpcDataContract[method].result shape.
        return this.store.answer(method, resource, params)
    }
}
```

`dataResources()` is the catalogue. `dataRequest()` is one verb-shaped dispatcher rather than one
method per operation. Both are required: an unlisted resource cannot be discovered, and a listed
resource that cannot answer is a permanently broken link.

An ordinary `RpcComponent` implements neither. Source RPC automatically publishes and serves its
`props` and `state` as tree resources, using the component contract and snapshot.

`dataResources()` is synchronous because `describe()` is synchronous at this boundary. Read an
external schema before exposing the component, cache it, and replace that catalogue deliberately
when it changes. Do not perform database or network I/O from `dataResources()`.

## Resource declaration

Every `RpcDataResource` declares one independently addressable collection.

| Field | Requirement | Meaning |
| --- | --- | --- |
| `path` | must | Non-empty, stable path of string segments. Unique within the component. `props` and `state` at the root are reserved. |
| `verbs` | must | Complete capability list. A caller must offer and invoke only listed verbs. |
| `row` | should | Runtime `TypeNode` for one row. Required for trustworthy generic columns, typed filtering, references and result validation. |
| `shape` | optional | Omit or use `list` for a flat collection; use `tree` only for provider-owned hierarchy. |
| `label` | optional | Human-readable resource name. It does not participate in identity. |
| `presentation` | optional | Portable ordering and grouping advice, never permissions or screen layout. |
| `actions` | optional | Existing RPC methods associated with a row. It adds no callable capability. |
| `references` | optional | Fields containing ids of rows in other declared resources. |
| `columns` | generated | Resolved writable fields, folded into `describe()` from the write provider. Do not use it as a read schema. |

Paths and ids are identity; labels and tree placement are presentation. Renaming a label or moving a
branch must not silently change the identity of a resource or row.

The declaration is closed. A request for an undeclared component-owned path or an undeclared verb
is refused before `dataRequest()` is called. A provider must still reject an impossible path or verb
when called directly; the dispatcher check is not a substitute for a total implementation.

## Capability profiles

Implement only the profile the resource can answer honestly.

| Profile | Declaration | What a generic consumer can do |
| --- | --- | --- |
| Flat collection | `getList` | Filter, sort and page rows. This is the minimum list. |
| Selectable rows | plus `getOne`, or `getMany` | Open one richer row, or retrieve known ids in a batch. |
| References | target has `getMany`; source may have `getManyReference` | Resolve foreign ids and browse the reverse relation. |
| Browse-only tree | `shape: 'tree'`, `getChildren` | Lazily open one branch at a time. |
| Scoped tree | browse-only tree plus `getList` | List, filter, sort and page leaves beneath any selected scope. This is the full tree-scope-grid profile. |
| Writable resource | read profile plus write verbs | Show only writes accepted by the separately enforced `$write` provider. |

A browse-only tree is valid. It is intentionally not enough for “all leaves below this branch”: a
viewer must report that aggregate as unavailable rather than walking the hierarchy and hiding an
unbounded number of requests. A tree used as the console's general scope-grid source should
therefore implement both `getChildren` and `getList` with recursive scoping.

`getOne` and `getMany` answer different questions. `getOne` may return richer detail. `getMany`
retrieves many already-known ids cheaply and preserves the requested order. A provider may expose
either or both.

## Verbs and invariants

The exported `RpcDataContract` is the normative parameter/result mapping. Callers can use
`RpcDataParamsFor<M>` and `RpcDataResultFor<M>` to keep a concrete verb paired with its shapes.

### `getList`

`RpcGetListParams` contains:

- `pagination: { page, pageSize }`, zero-based; `pageSize: 0` is a count-only request.
- `filter`, evaluated before sorting and paging.
- `sort`, evaluated over the filtered set before paging.
- `under`, the id of the tree branch to scope beneath.
- `recursive`, whether a tree answer descends beyond one level.

For a tree, `under` says where and `recursive` says how deep:

| `under` | `recursive` | Answer |
| --- | --- | --- |
| absent | absent or `false` | roots |
| branch id | absent or `false` | direct children of that branch |
| absent | `true` | leaves beneath all roots |
| branch id | `true` | leaves beneath that branch |

For a flat collection, `recursive` has no effect. `under` applies only to a tree.

The result must keep `ids[n]` and `data[n]` about the same row. Ids must be stable strings and
unique within the resource. Their order must be the requested order after filter, sort and page.
`total`, when present, is the number matching the filter before paging—not the page length. Omit it
when unknown. `hasMore`, when present, states whether another row follows this page; omit it when it
was not computed. Never use zero to mean unknown.

### `getChildren`

`getChildren` is the compatibility and lazy-browsing spelling of one non-recursive level. An absent
`parentId` asks for roots; a present id asks for that branch's direct children. It accepts the same
filter, sort and pagination rules as `getList`, but refuses `recursive` because the verb is one level
by definition.

Its result adds two arrays aligned positionally with `ids` and `data`:

- `hasChildren[n]` says whether asking beneath row `n` can return anything, and controls an
  expander.
- `grouping[n]`, when supplied, says whether row `n` is a branch used for scoping rather than a leaf
  shown in the value grid.

These are different facts. An empty folder can be a grouping branch without children. An OPC UA
Variable can be a leaf with property children. If `grouping` is absent, consumers fall back to
`hasChildren` for compatibility. Providers with complex leaves should always supply `grouping`.

`defaultChild`, when supplied, must be one of the ids in the same answer. It is advice only.

### `getOne`

The non-empty `id` identifies one row. Return `data` when found and omit it when absent; deletion
between listing and opening is normal, not a transport error. A richer detail row must still conform
to the declared `row`, so detail-only fields should be optional in that type.

### `getMany`

The request contains one to 1,000 string ids. Return only found rows, in requested order, with ids
and data positionally aligned. Missing ids are omitted rather than represented by placeholder rows.

### `getManyReference`

This is `getList` with a reverse relation already in hand. `target` is a field on this resource and
`id` is the value it must equal. Apply that equality together with the caller's filter, then sort and
page normally.

## Version and freshness fields

Every result carries `epoch` and `revision` from the component state against which the answer was
formed. An epoch changes when that component instance restarts. Revision is ordered only inside its
epoch. A provider must not assemble one answer from rows and metadata that claim incompatible
component versions.

An optional `stamp` says whether writes served by this node changed the resource. It is an equality
token, not an ordered revision and not proof that an external database did not change. Omit it if
the node cannot maintain that promise. `ms` is filled by Source RPC's dispatcher; `queryMs` and
`countMs` may be supplied when the provider measured those phases separately.

## Filtering and sorting

Filters are data, never executable expressions. Implement the closed `RpcFilter` grammar and its
bounded `all`/`any` groups. A missing `field` compares the row value; `id` compares the row id; any
other field is a dot path into the row. Case folding is valid only for `startsWith` and `contains`.

A provider must either implement an advertised filter or refuse it. It must not silently fetch a
page, filter that page, and report it as filtering the collection. The same applies to sort: sorting
only the returned page is not an implementation of `sort`. A bounded in-memory provider may
evaluate the complete set locally; a database or remote address space should push the operation to
the source so the transfer and work remain bounded.

## Errors, authorization and validation

Malformed requests and undeclared capabilities are `InvalidParams`. An absent row is an ordinary
empty/omitted answer. Store failures remain failures; do not turn them into empty collections.

Every `$data` request passes normal Source RPC authentication, authorization and deadline handling.
The browser or an aggregator must not bypass that by reading through a more privileged peer. Data
providers never carry credentials in resource declarations, rows, endpoints or presentation hints.

With `validateResults`, Source RPC checks returned declared-resource rows against `row`. Structural
answer invariants such as aligned `getChildren` flags are checked regardless. Enable result
validation in development and in the conformance fixture even when production disables it for cost.

## Portable metadata is not a UI

`presentation.defaultColumns`, `representation`, `detail`, `edit` and `sections` say which declared
fields matter first and which belong together. They never hide a field, grant a write, choose a React
component, set widths or colors, or replace the row schema. Unknown or stale paths are ignored with
a warning.

An action points to an already-described RPC method. The row id fills the method's first parameter;
remaining parameters come from the method contract. Authorization, effects, authority and command
semantics remain those of that RPC method. A DataProvider action does not create a second action
protocol.

A reference field contains the target row's id. Its target resource must be declared by the same
component and should implement `getMany`. Do not declare a reference to an arbitrary non-id field;
there is no lookup verb that could follow it truthfully.

## Implementer checklist

Before publishing a provider, verify:

1. Resource paths are stable, unique, non-empty, and do not replace root `props` or `state`.
2. Every advertised verb is implemented; no unadvertised behavior is needed by a consumer.
3. Row ids are stable strings and all positional arrays have the same length.
4. `row` describes every possible list and detail row; detail-only fields are optional.
5. Filtering and sorting happen over the complete selected set before paging; unbounded providers
   push them to the real data source.
6. `total` means matched rows and is omitted when unknown; `hasMore` is not guessed.
7. Tree resources answer one level through `getChildren`; scoped trees also answer recursive
   `getList` without requiring the viewer to walk.
8. `grouping` is supplied when branch-ness differs from merely having children.
9. Epoch, revision and optional stamp claims are no stronger than the provider can maintain.
10. Result validation and flat/tree, empty, missing, paging, filtering and sorting cases are tested.

The implementations in Source Relational, Source Document, Source Queue, Source Aspects and Source
OPC UA are examples of different valid profiles; none is a special console integration.

## What Source takes from react-admin

The interface is deliberately descended from react-admin's `DataProvider`: `getList`, `getOne`,
`getMany` and `getManyReference` have the same jobs, and an optional total or next-page fact allows
a provider to avoid an expensive count. The differences are deliberate consequences of crossing an
RPC network rather than calling an application backend in the same trust domain:

| react-admin | Source RPC |
| --- | --- |
| One method per verb | One `$data(method, resource, params)` RPC surface, paired by `RpcDataContract` |
| A resource is a string | A resource is a stable path inside a peer and component |
| Every row is an object containing `id` | A row may be scalar or object; string ids travel positionally beside data |
| The caller chooses a compile-time `RecordType` | The peer publishes a runtime `TypeNode`, usable by unknown clients |
| Filter and `meta` are open `any` values | Filters are a small checked grammar; portable metadata has named fields |
| `AbortSignal` is a provider option | RPC deadlines, disconnect handling and invocation semantics bound the call |
| Reads and mutations are one JavaScript object | Reads remain repeatable `$data`; writes use preconditioned `$write`, while one resource declaration advertises both |

The ra-tree package makes the tree boundary even clearer. Its
`addTreeMethodsBasedOnChildren` adapter can derive roots, parents, children and moves from ordinary
list/get/update calls, but its own warning says not to use that approach in production: several
operations fetch up to the entire tree and compound one logical move into many requests. Source
therefore makes `getChildren` a native provider operation, requires recursive `getList` for an
efficient scoped aggregate, and represents a move as one atomic, preconditioned `move` write.

Source does not currently need separate `getTree`, `getRootNodes` and `getChildNodes` verbs. Roots
and children are the two forms of `getChildren`; a complete or scoped leaf set is `getList` with
`under` and `recursive`. If a future consumer needs efficient parent/ancestor lookup, that should be
a new advertised provider capability—not a viewer walking or downloading the tree to derive it.
