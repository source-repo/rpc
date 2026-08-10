# State and observable components

**A peer is as much what it holds as what it can be told to do.** Methods are half the surface; the other half is state, and it is first-class here rather than something to be fetched with a `getStatus()` nobody remembers to call. A device publishes what it is, everyone who cares watches it, and reading costs nothing.

A long-lived instance whose state many peers want to *watch*, not poll. `RpcComponent<Props, State>` gives it two cached, read-only snapshots: `props` are the host's inputs — configuration, limits, a desired state where the domain uses that convention — and `state` is the instance's own public snapshot. Remote clients read both synchronously from a local cache and mutate neither: a client that wants the world to change calls a typed method, whose semantics, authorization, deadline and idempotency the library already carries.

That asymmetry is the design and not an omission. **Reading is a property access; changing is a call.** An assignment to a remote object has nowhere to put the facts a remote write produces — whether it was authorized, whether it arrived, whether it ran, whether the plant refused it — so it would have to fail silently or throw from a property setter, and it invites `oven.count++` and `oven.items.push(x)`, which are a read-modify-write against a stale cache and an array mutation nobody can order. A method call has an `await`, a deadline, an idempotency key and somewhere for a refusal to go.

```typescript
import { RpcComponent, rpc, rpcNamespace } from '@source-repo/rpc'

type OvenProps = { unit: string; maximum: number }
type OvenState = { temperature: number; mode: string }

@rpcNamespace('oven')
class Oven extends RpcComponent<OvenProps, OvenState> {
    constructor() {
        super({ unit: '°C', maximum: 200 }, { temperature: 20, mode: 'idle' })
    }

    @rpc({ semantics: 'idempotent-command' })
    async setMode(mode: string) {
        this.setState({ mode })
        return mode
    }
}

server.exposeClassInstance(new Oven())
```

`setState` takes a partial or an updater function; `replaceState` swaps the whole snapshot. Both are protected — the allow-list of `@rpc` marks is what keeps them off the wire — and commits made in one turn coalesce into one published snapshot. The host side controls props through `componentHost(instance).replaceProps()`, which nothing remote can reach.

## Observing one

```typescript
const oven = await client.component<Oven>('oven', 'ovenServer')

oven.props.unit          // synchronous, from the cache
oven.state.temperature   // likewise
await oven.setMode('heating')   // methods work exactly as on proxy()
```

`component()` resolves after the first snapshot has been accepted, so reads are synchronous from the first line that can execute. `RpcServer.component()` is the same call for a peer that both serves and calls — a browser page hosting a service observes over the link it already holds.

The store underneath is exposed via the `rpcComponent` symbol, and its shape is exactly what React's `useSyncExternalStore` consumes:

```typescript
import { rpcComponent } from '@source-repo/rpc'

const store = oven[rpcComponent]
store.getSnapshot()             // { epoch, revision, props, state, status, receivedAt, staleSince? }
const stop = store.subscribe(() => render())
await store.close()             // each component() call owes one close
```

## The status tells the truth

Every view carries `status: 'initializing' | 'live' | 'stale' | 'closed'`. A dropped link marks the picture **stale and keeps it readable** — "20 °C, stale since 14:03" is an answer and a blank is not — and a reconnect repairs it with one targeted snapshot rather than a replay. A restarted server is a new `epoch`, and the fresh snapshot replaces the old world; within one epoch, revisions only ever move forward, so a duplicate or delayed frame changes nothing.

Two observers of one component share one channel and one remote subscription; one leaving does not blind the other.

## Asking for less than the whole state

A snapshot travels whole on every change. For a mode, a health and a handful of reported values that is free and buys a great deal. It stops being free when a component carries a few hundred tags: three hundred values cross the wire so that one number can change, and on a 1200 baud link a 12 kB snapshot is **eighty seconds** — a screen showing twenty of those values cannot be drawn at all.

Name the paths and ask for those:

```typescript
const state = rpcRoot<FieldState>()

const oven = await client.component<Field>('field', 'bakery', {
    paths: [['state', ...rpcPath(state.zones.top.setpoint)], ['state', ...rpcPath(state.mode)]]
})
```

A path is spelled from the root it starts at, so the first segment is `props` or `state` — the same two roots a reader sees.

**What arrives is still a whole snapshot** — of the projection. That is the property worth protecting: duplicate delivery stays harmless, a reconnect is still repaired by one targeted frame rather than a replay, and the epoch and revision rules are untouched. Only how much of the state is in it changes, which is why this needs no base tracking, no keyframe schedule and no new counter, and why it is the thing to reach for before any delta encoding.

**A partial snapshot says that it is partial.** The view carries `projection`, the list of paths it contains. Without it a narrowed subscription and a component that had dropped half its state would be the same bytes, and anything merging them would be inventing. A whole snapshot carries no `projection` at all, so nothing reads it as partial.

### Paging a record you cannot enumerate

A path names what the contract knows, and a record is where the contract stops knowing: it says `{ [tag: string]: Reading }` and nothing about which tags exist, because **a record's keys are data, not type**. So a caller wanting fifty of three hundred tags cannot name them — the only path that reaches them is the record itself, which is all three hundred, and asking for everything to find out what to ask for is the thing projections exist to avoid.

A projection entry may therefore name a record and a window over it:

```typescript
const page = await client.component<Field>('field', 'bakery', {
    paths: [{ path: ['state', 'tags'], offset: 0, limit: 50 }]
})

page[rpcComponent].getSnapshot().slices        // [{ path, offset: 0, keys: […50], total: 300 }]
```

Keys and values arrive **together**, deliberately. Asking for the key list and then asking again for that page's values would be two round trips per page — nothing on a pipeline, and unusable on a link whose round trip is measured in minutes.

`total` is reported because it is the one thing a caller cannot work out for itself: its entries say what is on this page and nothing about the size of the set they came from. Nothing in the contract can say either.

A `limit` of `0` is therefore a **count**: it takes no entries and still reports `total`, so a caller learns how many pages exist for one number rather than for a record. The alternative — a count published as a prop — needs the component's author to have thought of it, and this needs nothing. The record is then absent from the snapshot rather than present and empty, which is the more honest of the two: `{}` would say it holds nothing, where the slice beside it says it holds three hundred and that none were asked for.

**Keys come back sorted**, and the order is part of the contract rather than an accident. Insertion order is a property of how the component happened to build its state, so page 2 could hold something different after a restart that populated the record in another sequence — a caller paging through would see one entry twice and another not at all, with nothing to indicate it.

Turning a page is a re-projection: the same subscription with a different offset. A slice naming something that is not a record yields an empty slice rather than an error, so "the record is not there" and "nobody asked" stay different answers. A negative or fractional `offset` or `limit` is refused rather than clamped, for the same reason a negative timeout is — a silently adjusted page is one nobody asked for and no way to notice.

A path that reaches nothing is simply absent rather than an error — state is data, and a tag that has not appeared yet is a legitimate thing to watch for. An empty path list *is* refused, because subscribing to nothing looks exactly like a component that has gone quiet, and that is the wrong thing to spend a night on.

**One peer holds one subscription per component.** The server keys a subscription by instance, event and caller, so a second view of the same component with different paths would be one subscription whose contents depended on who opened first. That is refused, naming both projections, rather than silently serving the other one's paths. Re-subscribing with different paths — the same peer changing its mind — replaces the projection rather than merging, so a narrowing is always possible; a union would keep sending what nobody watches any more.

A projection is a narrowing, so it needs none of the gating a generic setter does: asking for less than you are already entitled to exposes nothing new, and `authorize()` sees the paths like any other parameter. And it survives a reconnect — the replay carries the paths, since re-subscribing without them would quietly restore the whole snapshot on the one link that cannot carry it.

A slice is a **live window**: it keeps pushing, and what it pushes is whichever entries currently sit in that range. When what you want is one page in answer to a question — these fifty, matching this, in this order — that is a different operation, and it is the next section.

## Asking for a page instead of watching one

A projection narrows what a subscription pushes. It cannot say *which* fifty of three hundred, because that is a question — a predicate, an order and a page over data the caller does not hold — and a question wants asking rather than subscribing.

`$data` is that ask, and its shape is react-admin's **DataProvider** rather than an invention of ours, because that is the interface several hundred backends already implement:

```typescript
const field = await client.proxy<RpcComponentProxy<Field>>('field', 'bakery')

const page = await field.$data('getList', ['state', 'tags'], {
    pagination: { page: 0, pageSize: 50 },
    filter: { field: 'quality', op: 'eq', operand: 'bad' },
    sort: { field: 'value', order: 'DESC' }
})

page.ids       // the keys of the rows on this page
page.data      // the rows, positionally
page.total     // how many matched — which is what a pager needs, not how many exist
```

A component gets this **free** wherever its state holds a record: the base class serves it from the contract, the way `$acquire` is served, and the author writes nothing.

### Serving collections the contract cannot describe

A record in `props` or `state` needs nothing declared: it is in the published type, so a viewer finds it by reading the contract and addresses it by the path it already has. A table, a document collection or a queue is the other kind — **what resources exist is itself data**, discovered when the component connects to its store, so it cannot be extracted from source and has to be said at runtime:

```typescript
class Store extends RpcComponent<StoreProps, StoreState> implements RpcDataResources {
    dataResources() {
        return [{ path: ['customers'], verbs: ['getList', 'getMany'], label: 'Customers', row: customerRow }]
    }

    dataRequest(method: RpcDataMethod, resource: readonly string[], params: RpcGetListParams | RpcGetManyParams) {
        return this.query(method, resource, params)      // whatever the store actually is
    }
}
```

`describe()` then carries them under the component — the path, the shape of a row, and the verbs each answers — so a viewer that has never heard of this component draws its columns from the contract exactly as it draws an oven's. Structure and never a row, like everything else `describe()` says.

Both methods are required together on purpose: a component that listed resources it could not answer for would publish a table that renders as a permanent error, and one that answered for resources it never listed could not be found at all. A declared path is answered by the component; anything else falls through to the record rule above, so a component that serves a store keeps ordinary access to its own state.

The verb list is what a viewer offers from, so it is worth being accurate: the console draws a resource only if it answers `getList`, because that is the only thing its grid can do with one, and a node that appeared and then refused every selection would be worse than one that was never offered.

Resources are read at describe time rather than fixed at exposure, so a store that gains a table says so on the next describe rather than at the next restart.

**Why a call rather than a wider projection.** A projection is re-applied per subscriber on every publish, so a predicate living there would make every commit a query on a peer that may be a small computer running a process. Worse, a filtered page is *unstable* under push: matches depend on values, values change, so one tag going bad enters the match and renumbers every row beneath it with nothing on screen to say so. A call is answered once, when somebody asks, with a deadline and an `authorize()` check on it. Values stay current because the caller asks again on a period **it** chooses — which is also the only rate control a subscriber has on a slow link, since a subscription's rate belongs to whoever is publishing.

**A filter matching nothing transfers nothing.** That is the property no amount of client-side filtering can have, because discovering that nothing matched is exactly what it must receive everything to find out. Filtering happens before the page is cut, ordering before that again — a filter applied after paging would be a filter over fifty rows pretending to be one over three hundred.

The filter is a closed grammar rather than an expression: a condition is `{ field, op, operand }` with `op` one of `startsWith`, `contains`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, and conditions combine with `{ all: […] }` and `{ any: […] }`. `field` is `id` for the row's key, a dot path for a field inside the row, or absent for the row itself — which is the only thing there is to compare in a record of numbers. Nothing that *runs* ever crosses the wire, deliberately: this is evaluated on the peer holding the plant, and again every time the page is asked for, so a regular expression here would be a program handed to a machine with a process attached.

`total` is the count of **matches**, which is what "3 of 47" means and what a pager reads. A `pageSize` of `0` asks for no rows and answers the total, which is how a caller learns the number of pages before deciding to fetch any.

It is always present today, and that will have to give: `COUNT(*)` over a filtered table is not free, and react-admin carries `pageInfo.hasNextPage` instead for exactly that reason. A record held in memory can always afford the count, so the only implementation there is can always supply it — but the first store-backed component makes this optional with a `hasMore` beside it.

Pages are zero-based, so `page * pageSize` needs no adjustment anywhere. A page past the end answers empty with the true total rather than erring, because the set is data: a page that was valid when the operator clicked may be past the end by the time the request lands, and that is a race no caller can avoid. A malformed bound — negative, fractional, or a page number with no `pageSize` to measure it in — is still refused, since that is a caller holding it wrong.

Every answer carries the `epoch` and `revision` it was drawn from, so a page and a subscription can be compared rather than merely coexist, and a restart is visible to a caller paging through.

### What may be done to a row

A resource can say which of the component's **own methods** apply to a row of it:

```typescript
{ path: ['deadLetters'], verbs: ['getList'], actions: [
    { method: 'retryDeadLetter', label: 'retry' },
    { method: 'discardDeadLetter', label: 'discard', confirm: true }
] }
```

This adds no capability at all. Each is an ordinary `@rpc` method that already exists, already appears in `describe()`, and is already ruled on by `authorize()`, the owner fence and idempotency. What the declaration carries is the one fact a viewer cannot work out for itself — *which* existing method is about *which* row — and that is exactly what `sets` does for a field, one level up. The rule is unchanged: a value is never written, a method is called.

Without it a viewer can browse a resource and do nothing to it, because an editor resolves from `sets` and a store-backed resource has no state path for any method to claim.

Each action is called with the row's id and nothing else. `confirm` is the author's judgement about its own method, not a viewer's guess from the name — a console inferring it from the word "discard" would be guessing about a plant, and would be wrong the first time somebody wrote `archive`.

A viewer **checks the method exists** before offering it. A typo in a declaration would otherwise draw a control that always fails, which is worse than no control: an operator finds out by trying it.

### How long it took, and which half

Every answer carries `ms`, filled in by the dispatcher whoever served the resource. A component that can separate the two halves also reports `queryMs` and `countMs`.

They are one number for a record held in memory, because filtering produces the matched set and `total` is its length — the count is a byproduct and costs nothing. They are two very different numbers over a real table, where `LIMIT 50` is answered from an index and `COUNT(*)` over the same predicate walks it, and the second is routinely most of the time.

The split is reported rather than inferred because the difference decides what to do. **A slow page wants an index. A fast page behind a slow count wants something else entirely** — the count asked for less often, or estimated, or not asked for at all — and nothing can choose between those without seeing which half the time went to. Absent where the split does not exist, which is itself an answer.

`slowRequest` on the server carries the same breakdown, so the peer says which half held it up rather than only that something did.

### Rows a caller already knows the ids of

```typescript
const rows = await field.$data('getMany', ['state', 'tags'], { ids: ['tag.007', 'tag.001'] })
```

Plural from the start, and that is the whole point: a page of fifty rows each naming a customer is fifty lookups, and fifty calls is fifty envelopes and — on MQTT — fifty exchanges. One `getMany` for the page is what makes a reference field affordable at all, and it is the same instinct `rpcWrites` and a projection's path list already apply by hand.

Rows come back **in the order asked**, so a caller pairing them to the fields that named them does not have to sort them itself. An id that reaches nothing is **absent** rather than filled with a null, because "this row is gone" and "this row has no value" are different facts and one of them means a reference is dangling. There is no `total`: nothing here is a page, so nothing here has a count of pages. The request is bounded at 1000 ids, since it arrives from the network and ten thousand in one frame is a caller that meant to page.

### One-to-many

```typescript
const theirs = await store.$data('getManyReference', ['orders'], { target: 'customerId', id: 'c1' })
```

The rows of one resource that point at one row of another: the orders of this customer, the readings of this tag. It is served as `getList` with the reference **and-ed onto** whatever filter the caller sent, rather than as a second implementation — so paging, ordering, the count of matches and the treatment of a page past the end are identical by construction rather than by having been written twice the same way. `total` is the count of *referencing* rows, which is what a pager under a record needs.

A caller's own filter narrows further rather than replacing the reference, so a search inside a one-to-many cannot accidentally widen back to the whole resource.

That is the claim the DataProvider shape was taken for, arriving as almost no code: one-to-many is not a new mechanism, it is a list with the join already in hand.

Writes are ordinary declared methods that happen to have standard names, so `authorize()`, the owner fence and idempotency all apply per call and none of it is special-cased. `getOne` is not served — a caller that wants one row asks `getMany` for one id, and a verb that exists only to be a worse version of another is not worth the wire.

## Publishing bounds

Expose options bound what the network hears — local state always changes immediately:

```typescript
server.exposeClassInstance(oven, 'oven', {
    component: { minPublishIntervalMs: 250, maxSnapshotBytes: 1_048_576 }
})
```

`minPublishIntervalMs` coalesces publishes to at most one per interval, latest wins — conflation being the honest behaviour for state. `maxSnapshotBytes` is a tripwire for a waveform buffer wired into state by mistake; the commit succeeds, the publish is skipped and logged. High-rate telemetry belongs in events or a queue, not in a snapshot.

## Saying what a method sets

Reading state is a property access, and changing it is a call. Which leaves a question for anything drawing a panel: given `state.setpoint`, *which* method changes it?

The tempting answer is a naming rule — look for a one-argument `set<Field>`. It is right almost always, and almost always is exactly the problem. `setMode` might not assign `state.mode`; it might begin a mode transition with a purge cycle and an interlock behind it. `setPressure` might command a setpoint while `state.pressure` is the measurement beside it, so an editor drawn on the measured value writes somewhere the operator did not mean. When the guess is wrong it is wrong *silently*, in the direction of commanding a plant, and nothing on the row shows it.

So it is declared, next to the semantics that were being declared anyway:

```typescript
@rpc({ semantics: 'idempotent-command', sets: 'setpoint' })
async setSetpoint(celsius: number) { … }

@rpc({ semantics: 'idempotent-command', sets: 'zones.top.setpoint' })
async setTopSetpoint(celsius: number) { … }
```

`extract` reads it, `MethodSchema` carries it, `describe()` reports it, and a console draws an editor on exactly the paths some method claims — no naming rule, nothing to get wrong when a class is minified, and a nested `zones.top.setpoint` becomes expressible where a naming rule could never reach it. The `zones.top.temperature` beside it, identical in shape and type, correctly gets nothing.

**It does not make the field writable, and nothing here writes anything.** The method body stays yours, which is the whole point: it can clamp, refuse while the door is open, check an interlock. That validation is why a plant has `setSetpoint` rather than a public field, and declaring the path keeps all of it.

Two refusals, both at expose time rather than in production. A method declaring `sets` on a class that is not an `RpcComponent` has no `state` for a path to name — the same shape of check `requiresAuthority` gets, and for the same reason: a declaration that silently describes nothing is the worst way for this to fail. And `sets` with `query` semantics is a contradiction in one breath; which of the two declarations is wrong is the author's to decide, so neither is quietly preferred.

Unlike `semantics` and `effect`, `sets` carries no compatibility rule. A method that stops claiming a path removes an affordance from a console — a change in what tooling can offer, not a promise to callers that has been broken.

## The generic setter, and its gate

Per-field declarations are right for the handful of commanded values on an oven, and absurd for a component carrying three hundred tags — three hundred markers and three hundred methods to hang them on. For that, one method takes the path:

```typescript
@rpc({ semantics: 'idempotent-command', sets: '*' })
async set(path: string[], value: unknown) {
    const [root, tag, field] = path
    if (root !== 'tags' || path.length !== 3 || field !== 'value') throw new Error(`${path.join('.')} is not writable`)
    …
}
```

So one option covers both cases, and the rule for anything reading the contract stays "what does this claim", never "what is this called".

**It is refused unless the host opted in.** A method that writes wherever its caller names is a different kind of surface from one that commands a value somebody thought about, so it is off by default:

```typescript
const server = new RpcServer({ …, allowStatePathWrites: true })
```

This is `topology.allowRemoteMutation` in the other direction and deliberately the same shape: a deployment that never enables it has no such surface at all, however its classes are written. A host with the gate shut does not even *advertise* the claim — `describe()` reports what the server will honour, so `sets: '*'` is withheld and a console draws no editor from it and a model is offered no tool. Call the method anyway and the refusal names the flag.

**Enabling it opens nothing by itself.** The call still passes `authorize()` with the path in params, so a policy can rule on *which* path rather than only on the method. And the body is still yours — which is the part the library must not supply, because a writer handed over by the framework would be a public field with extra steps. `sets: '*'` says a method **can** set paths, never that every path is open, and the example above refuses all but one shape of them.

The trade is bluntness. A generic setter claims every path by construction, so a consumer will offer to write measured values too, and those attempts fail where the value would have been. That is the honest consequence of one method standing in for three hundred, and it is why a plant's answer stays the per-field declarations, whose methods carry the interlocks — the generic form is a development affordance, which is exactly what a component with three hundred tags being browsed by a person is.

### Naming the path from the calling side

A path written as a string is the one part of an otherwise checked call that nothing checks. `rpcRoot` and `rpcPath` fix that by recording what the caller meant:

```typescript
const state = rpcRoot<FieldState>()
const writer = await client.proxy<RpcPathWriter>('field', 'bakery')

await writer.set(rpcPath(state.tags['flue.temp'].value), 21.5)     // typed; a word here does not compile
```

The proxy records the properties that were read and returns the segments they spell, carrying the type at the end. Completion works, a rename moves it, and a misspelling does not compile.

**The served method is concrete and the caller's interface is the generic one**, which is not an accident: `extract` describes a contract in a runtime type language, and `set<V>(path: RpcTypedPath<V>, value: NoInfer<V>)` has nothing there to describe — it is refused loudly rather than published as `any`, the same refusal an unresolved generic component gets. So the class serves `set(path: string[], value: unknown)`, and a caller that wants the compile-time half asks `proxy<T>()` for `RpcPathWriter`. That is ordinary use of the existing machinery rather than anything new.

Losing the compile-time check on the wire costs less than it looks, because it is not the only one: the state interface travels in the contract, so the type at a path is published, and a console or the MCP `set_state` tool refuses a wrong value from the contract alone before it travels.

For several fields at once there is `rpcWrites`, which buys back assignment syntax without giving up the outcome:

```typescript
await oven.apply(rpcWrites<OvenState>((state) => {
    state.zones.top.setpoint = 180
    state.mode = 'heating'
}))
```

Two fields, one command, one `await` with somewhere to put a refusal — which a per-field setter cannot offer and an assignment to a remote object cannot either. A draft is write-only in intent and cannot be made so in the type system, so the one rule is that it is never read from. `apply` is your method, declared `sets: '*'` like any other path writer.

## In the contract

`extract` reads a component's `Props` and `State` through the base-type chain and writes them into the schema (`component: { snapshot: 1, props, state }`); an unresolved generic is a loud diagnostic, never a silent `any`. The compatibility checker treats both shapes as output — a component that stops being served, or widens what it may send, is named to the observer — and `describe()` reports structure plus a live observer count, never the values.

`validateComponentSnapshots: true` on the server checks each commit against the contract before it becomes current: an invalid `setState` throws at the call site — where the bug is — and the previous snapshot stays current.

## Reserved names

`$snapshot` is the event snapshots travel under, reserved the way `$with` is: served to authorized subscribers only, never listed in introspection. A component also answers `$acquire`/`$release` — see [Command authority](./authority.md).
