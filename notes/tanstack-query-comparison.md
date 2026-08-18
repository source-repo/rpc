# What TanStack Query fakes, and where this does the same thing one level down

Research comparison. TanStack Query is the state layer a React application reaches for by default and the library README already sends a browser-plus-one-backend reader to it, so it is worth knowing precisely what it does that this does not. What the comparison turned up first, though, is one thing about freshness that both get wrong in the same shape, and that is the spine of this note — the feature list comes after it, because several items on the list are consequences of it. Nothing here is implemented; several items are cheap enough that not doing them is a decision rather than a backlog.

## Staleness is a policy wearing the costume of a fact

`staleTime` is the application author guessing how long a value stays true, and `isStale` then draws that guess as though it were a property of the value. It is wrong in both directions. A query with `staleTime: 30_000` shows the old setpoint confidently for thirty seconds after the plant changed it; one past its window is marked stale though nothing has moved in a week, and then spends a round trip to learn that nothing has. The default makes it plainer: `staleTime: 0` means everything is stale the instant it arrives, which is honest and useless — so every application raises it, and raising it is where a confession turns into a fabrication.

Underneath that is the structural version, which is the part worth carrying around. **A pull cache has no state for "I am being kept current".** There is nothing that could set it, so *recent* is the only proxy for *current* available, and the two are rendered identically. That is the same collapse this library refuses on the command side — `TransportError` against `UnknownOutcome`, *certainly did not run* against *may have run* — arriving on the state side as *confirmed current* against *not known to be otherwise*, flattened into *recent enough*.

Fairness where it is due, because the fake is structural rather than careless. `dataUpdatedAt` is a real fact: the server confirmed this at T. The v5 split of `status` from `fetchStatus` is precisely a refusal to collapse two different facts into one spinner, which is the same instinct that produced `UnknownOutcome`. `isPlaceholderData` labels data that is not real. TanStack fakes freshness because nothing tells it, and it is candid about everything it can actually observe.

## Which is why the push path is not where the comparison is interesting

Being told is what a component channel is. `epoch` and `revision` are the publisher's ordering rather than the receiver's guess, `status` reports that snapshots have stopped arriving instead of inferring it from a clock, and `staleSince` is when the knowledge stopped rather than when a window elapsed. TanStack has no notion of a feed that was live and is now of unknown age, and its `select` narrows only after the bytes have arrived, where a projection narrows the wire.

So most of TanStack's machinery — staleness windows, focus refetch, retry schedules — exists to approximate what the channel is simply told, and copying it onto the push path would be spending the link to guess at an answer already in hand. That is the reason several obvious-looking imports are refused further down rather than ranked.

**The interesting comparison is the pull path, because there is one and it has no cache at all.** `$data` is a call, `query`-semantics methods are calls, and the console had to write [`packages/cli/web/src/polled.ts`](../packages/cli/web/src/polled.ts) to make a grid out of them — which is a small, correct, unshared TanStack Query: keep the previous answer while fetching, schedule the next ask from the settle rather than on an interval, pause while the pane is hidden, allow an out-of-band refresh. Every one of those is a TanStack default. That file existing at all is the finding: the pull half of the state layer lives in the console instead of in the library, so nothing else on the network gets it.

## The same fake, one level down

`status: 'live'` is a fact about the **link** — snapshots are arriving — and it is read as a fact about the **values**, which is a different claim and frequently not true at the same time. A snapshot is atomic: one epoch, one revision, and no per-value age. So a component fronting fifty devices publishes a live snapshot while three of them have not answered a poll in ten minutes, and nothing in the snapshot says which three. What the reader sees is `live`, `rev 4471` and twenty numbers, of which seventeen are current and three are from 14:03.

`receivedAt` does not rescue it, and the code already says why: *"Local receipt time. Useful for display; never for distributed ordering — clocks disagree."* It is the age of the last hop, not the age of the measurement. The honesty this library is careful about stops at the edge of the library, and on a plant the interesting part is on the other side of it.

That is what OPC UA carries `SourceTimestamp` and `StatusCode` for, separately from `ServerTimestamp`, and why Sparkplug stamps every metric and a host marks a node's whole tag set stale on its NDEATH. `@source-repo/sparkplug` is already in the repository, so the vocabulary is in the building rather than something to invent.

The design question is narrower than "add quality codes", which is a large surface most components have no device behind: a snapshot needs a way to say **which parts of it are sourced, and when each was last confirmed**, so that `live` and "these twenty are last known from 14:03" can be true at once. Without that there are two available answers and both are wrong — mark the whole snapshot stale because one sensor went quiet, or mark nothing stale and let three values pass as current. A last-confirmed per branch is most of the value for a fraction of the surface, and it composes with what exists, since a projection already names branches and a slice already reports what it did not carry.

It is deliberately not on the list below. Nothing here comes from TanStack — a pull cache cannot have it — and it is what the comparison turned up by contrast rather than by copying, which is the more useful of the two things a comparison can produce.

## The ones with a plant argument

### A subscription recovers when the *link* comes back, never when the *peer* does

`resubscribe()` is wired to the transport's `connected` event and to nothing else ([`RpcClient.ts`](../packages/rpc/src/RpcClient.ts), [`RpcServer.ts`](../packages/rpc/src/RpcServer.ts)). Over a bus, the case that matters does not touch the link: the observed peer restarts, the observer's connection to the bus never drops, and so nothing replays the subscription. `ComponentChannels` marks the view stale on `peerGone` and there it stays — `peerOnline` is forwarded to the application and no recovery is keyed to it. A single `resubscribeFailed` is emitted once and never retried, so a peer that was still booting during a reconnect is also lost until the next disconnect.

TanStack's name for this is `refetchOnReconnect`, and the thing worth taking is not the mechanism but the observation that in a peer network there are **two** reconnects and only one of them is handled. The library already holds everything needed: the channel knows its `target`, `peerOnline` names the peer that returned, and re-subscribing is idempotent by design. Retrying `resubscribeFailed` with a backoff is the same fix from the other end.

This is the item to do first, and it is closer to a defect than to a feature.

### Paused, rather than failed — with `semantics` deciding what may be paused

TanStack's `networkMode` puts a request that cannot be sent into `fetchStatus: 'paused'` instead of failing it, and runs it when the connection returns; with the persister, paused *mutations* survive a page reload and `resumePausedMutations()` replays them.

Here the choice is `failCallsOnDisconnect` — fail everything now — or wait out the deadline, and nothing is queued for a peer that is not connected. That is the honest default and it should stay the default. But this is the one library that can offer the alternative **safely**, because a method declares what repeating it does: a `query` may be paused and re-issued freely, an `idempotent-command` likewise, and a `non-repeatable-command` may be paused only when the caller supplied an `idempotencyKey` — and refused, naming the reason, when it did not. TanStack has to make that the application's problem because it has nothing in the contract to consult. Here the answer is already declared.

Two conditions, without which this is worse than failing. A paused command must be **visible as paused** — a queued start that fires four minutes later without an operator seeing it queued is exactly the accident `UnknownOutcome` exists to prevent. And a paused command must not outlive its own deadline: the ttl is what the caller said it would wait, so resuming past it is sending a command nobody is waiting for, and the server would refuse it on the post-queue deadline re-read anyway.

### There is nowhere to see the commands that are in flight

TanStack keeps a `MutationCache`, and `useMutationState` lets any part of the tree read what is currently being written. Nothing here aggregates calls: each `await` owns its own outcome and the richest error vocabulary in the library — `UnknownOutcome`, `Superseded`, `NotInControl` — is visible only at the call site that happened to make the call.

A `client.commands` store, in the same shape the component store already has, would give an HMI a pending-commands tray: what was sent, to whom, how long ago, and which of them came back `UnknownOutcome` with the idempotency key still attached so the retry is a *retry* rather than a second command. The README opens on precisely that scenario — the operator who presses start twice — and the library stops one step short of the affordance that resolves it.

TanStack's mutation `scope` is worth a glance beside this: mutations sharing a scope id run one at a time. The server-side mailbox already orders per instance or per key, so this would buy nothing on correctness — but the client-side half is what keeps a second click from being *sent* while the first is outstanding, which is a different and cheaper thing than ordering it after it arrives.

### The push channel should invalidate the pull cache — which TanStack cannot do at all

TanStack invalidates by guessing: after a mutation, name the query keys you think it touched, and `invalidateQueries` refetches them. It has no other option, because the server never tells it anything.

Every `$data` answer already carries the `epoch` and `revision` it was drawn from, and every snapshot carries the same pair. So a cache keyed by (peer, namespace, resource, params) can be invalidated **exactly**: a snapshot arriving at a higher revision than the page was drawn from marks that peer's pages as possibly-changed, and a new epoch drops them outright. No key taxonomy, no guessing, and no invalidation written by hand.

There is a second source of the same signal in the contract. `sets` already declares which state path a method changes, so a command that claims `tags.*` is a command whose answer names the resource whose pages are now suspect — derived from the declaration rather than maintained beside it, which is the argument `sets` was introduced with in the first place.

This is the item with the best ratio of value to novelty, and it is the one thing on the list that TanStack would want and cannot have.

### A cache for `$data` and for `query` methods

With invalidation available, the rest of `polled.ts` is worth promoting into the library and giving the properties it does not have:

- **Deduplication of identical in-flight requests.** Two panes showing one table are two requests today. On a link where a page costs eighty seconds this is not a nicety.
- **The previous answer stays readable** while the next one is in flight — already right in the console, and the same judgement `stale` makes for a snapshot.
- **A freshness window.** "This page was answered 400 ms ago" is enough to not ask again when a screen has thirty widgets bound to six distinct questions.
- **The next ask scheduled from the settle**, never on a fixed interval — the console's comment on why is the whole argument, and it belongs where everyone gets it.

The period stays the caller's, which is the point [`DataProvider.ts`](../packages/rpc/src/RPC/DataProvider.ts) makes about a subscription's rate belonging to whoever publishes. A cache does not change who chooses; it changes how many times the choice is paid for.

## The cheap ones

### Structural sharing

TanStack compares each result against the previous one and keeps the old reference for every subtree that did not change, so `data.zones === previous.zones` when nothing under it moved. Here `accept()` installs a view built from freshly parsed JSON, so every object identity changes on every publish — one tag moving at 10 Hz re-renders every consumer that selected an object rather than a primitive.

The console already works around it and the workaround is the evidence: `useChannelFact` selects only primitives so `useSyncExternalStore` can bail out, and `useKeysAt` joins a record's keys into a *string* to get something comparable. A merge in `accept()` that preserves references for unchanged subtrees is perhaps thirty lines, changes no wire format, and makes ordinary memoization work for everybody.

It also produces the changed-path set as a byproduct, which is what a client-side trend recorder or alarm evaluator needs — change-of-value logging is a SCADA tag setting, and here it would fall out of the cache rather than being asked of the plant.

### A selector on the store

`RpcComponentStore` is `getSnapshot`, `subscribe`, `close`. TanStack has `select` with a memoized comparison, and tracked properties so a component re-renders only for the fields it read.

The symmetry is worth stating: **a projection narrows the wire and a selector narrows the render**, this has the first and not the second, and the console built the second by hand in `ValueTree`. `store.select(pathOrFunction, isEqual?)` returning a derived store would move it into the library, and with structural sharing underneath it would be correct for object-valued selections too, which the per-leaf trick is not.

### Keep the cache when the last observer leaves

TanStack keeps an inactive query for five minutes (`gcTime`) so a remount is instant. Closing the last pane on a component here drops the channel immediately, and reopening it pays `initializing` and a round trip.

The adaptation is not TanStack's, though, and the difference matters: **keep the cache, drop the subscription.** A warm subscription keeps spending the link on a screen nobody is looking at, which is the opposite of what a plant wants. Reopening then shows the last known values marked `stale`, with their age, and one targeted snapshot repairs it — entirely within the existing vocabulary and with nothing new to explain.

### Stop listening while the tab is hidden

`usePolled` stops asking when the pane is hidden. Component channels do not: a console left open on a spare monitor over a weekend receives every snapshot of every component it ever opened.

The same rule — unsubscribe on hide, resubscribe on show, view goes `stale` meanwhile — is TanStack's `refetchIntervalInBackground: false` translated into push, and it costs one document listener. The one thing it must not do is apply to a screen somebody deliberately left running as a wall panel, so it is an option rather than a default, and a wall panel is exactly the case a default would break.

### Survive a reload showing what was last known

`persistQueryClient` writes the cache to storage and restores it on boot, with a buster and a max age.

The doctrine here is already that last-known-with-its-age beats a blank — a reload is the one place it is not honoured, and the page comes back `initializing`. Persisting each channel's last snapshot and restoring it as **`stale`, never `live`**, with its original `receivedAt`, applies the existing rule across a reload. The epoch makes the guard free: a restored snapshot whose epoch the server no longer reports is dropped rather than reconciled, and a max age past which last-known is not worth drawing is a number the deployment picks.

## Worth thinking about, not obviously worth doing

**Cross-tab sharing.** `broadcastQueryClient` shares one cache between tabs; here the equivalent is a SharedWorker holding one link, so an operator with four tabs costs the plant one subscription per component rather than four. More valuable here than there, because the link is scarcer — and more work, because the link carries identity and authority rather than only data.

**Devtools for the client's own state.** `console` and `tap` show the network; nothing shows *this application's* cache — which channels are open, their revision rate and bytes per second, what is stale and since when, what is paused. Given that the tooling is half the point, the absence is more conspicuous here than it would be in another library.

## What should not be copied

**Refetching a subscription on a timer.** Staleness-driven refetch exists because a query cache is guessing. Polling on top of a subscription would be guessing where an answer is available, and it would spend the link to learn what the next publish was going to say anyway.

**Optimistic cache writes.** TanStack's `onMutate` writes the expected value into the cache and rolls back on error. On a plant that draws a setpoint the plant has not accepted, on the same screen and in the same place as values the plant did accept, and the operator cannot tell them apart — which is the failure `Reading is a property access, changing is a call` was written to prevent, arriving through the back door of the cache. The correct adaptation is the command tray above: **the value stays what the plant last said, and the command in flight is drawn beside it.** "Commanded 180, awaiting feedback, 3 s" is both facts; an optimistic 180 is one fact pretending to be the other.

It is also the freshness fake in its strongest form, which is why it sits at the end of this note rather than in the middle of the list. `staleTime` fakes *when* a value was last true. An optimistic write fakes that it was ever true anywhere.

**Cursor-based infinite queries as the model.** The page model is offset-based with a true `total` because a pager under a live record needs "3 of 47", and a record's keys are data so a cursor into them is not stable across a restart. What is worth borrowing is the reason TanStack carries `hasNextPage` — an unavoidable `COUNT(*)` — which [the components guide](../docs/guide/components.md) already anticipates for the first store-backed component.

## For calibration: what this has that TanStack does not

Not a defence, but the list is short enough to be useful when weighing anything above against the cost of adding it.

Epoch and revision acceptance rules, so a duplicate or a reordered frame changes nothing and a restart is visible. A status that distinguishes a feed that has stopped being current from one that never started, with the last value still readable and its age on it. Server-side narrowing, so the bytes never leave. Command authority in the snapshot, so who holds the panel is part of the state rather than an application convention. Declared semantics, which is what would make a paused-command queue safe rather than a gamble. And a subscription at all: `streamedQuery` is a pull that streams its answer, not a peer telling you something changed.

None of which touches the question the first half of this note raises. Being told promptly that a snapshot changed is a different property from being told what each value inside it is worth, and this has the first and not the second — the one place where the comparison found this library doing the thing it is being compared favourably against.
