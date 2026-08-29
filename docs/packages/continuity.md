# @source-repo/continuity

What a component keeps when the process implementing it is replaced: versioned state snapshots, adjacent forward migrations with reviewed defaults, the work a running activation was holding, a record of every value that moved — and the replacement itself, under a fence.

```
npm install @source-repo/continuity
```

- **Held state is explicit, and the rule is enforced** — state is structure-cloned before every step, so state living in a language's object layout is refused with the reason rather than discovered at a handoff.
- **One reviewed transform per adjacent version** — vK to vN walks the chain, which is one place per version where somebody had to decide what a new field means.
- **Three outcomes, not three degrees of success** — `total`, `defaulted` with the field, value and grounds recorded, and `impossible`, which refuses rather than inventing a value nothing downstream could tell from a measured one.
- **No separate dry run** — migration is a pure function of an immutable snapshot, so the thing that was checked is the thing that runs.
- **Determinism is checked, not assumed** — every step runs twice and its outputs are compared, which catches the two that actually happen: a clock and a random value.
- **A barrier, and one instant** — `holdExecution` queues arriving calls rather than rejecting them, and `captureAtBarrier` takes the values and the outstanding work in the same held breath or refuses.
- **Doing the work and recording it are one act** — `RpcManagedRuntime` arms the timer and registers the obligation in the same call, so there is no order of statements in which one happens and the other does not; a managed timer's callback runs on the component's own serial chain, where a barrier can hold it, rather than wherever the event loop delivers it.
- **Unmanaged writes are caught in the act** — a component held at a barrier whose revision moves anyway is being changed by something the runtime never dispatched, and `settleMs` refuses `unmanaged-mutation` instead of sealing values from after the barrier under a position from before it.
- **Every obligation gets a disposition** — a timer, a call in flight, a lease or a subscription the successor says nothing about is `unhonourable`, never assumed; a timer has no default policy because every policy is catastrophic somewhere.
- **The plan is proved twice** — once while preparing, once against the snapshot actually taken at the barrier, because a component that took on work in between is owed a different set of things.
- **The commit point is the compare-and-swap and nothing else** — before it, abandoning is free and no caller can tell; after it, the coordinator will not put the incumbent back, because the successor may already have touched the plant.
- **A fence has two halves** — the local one is what the activation holds, and the one at the sink is the only one that survives a partition, because it does not require the stale activation to know anything.
- **A store says what it can guarantee** — `linearizable`, `durable`, `fencedAtTheSink`, stated rather than implied; the in-memory reference store answers `false` to all three.
- **Callers address a name** — a resolution carries the epoch it was taken under, and that is its shelf life; holding the address without it is a destination that stops being correct silently.
- **It crosses languages** — a snapshot written here verifies to the same content hash in `SourceRpc.Continuity`, checked against fixtures both suites read verbatim rather than asserted.
- **Positions cross as decimal strings** — JSON has one numeric type and it is a double, and a sequence position that rounds is a successor that reprocesses input or skips it. A position that arrived as a number is refused, never converted.
- **Portable is stronger than cloneable** — a `Date`, a `Uint8Array`, a `Map` and a `bigint` all clone perfectly and none of them cross a language boundary as themselves.
- **A manifest describes a revision and does not approve one** — an artifact that could authorise itself by asserting its own capabilities would make the approval path decorative.

Full documentation: the [package README](https://github.com/source-repo/rpc/blob/main/packages/continuity/README.md). On npm: [@source-repo/continuity](https://www.npmjs.com/package/@source-repo/continuity).
