# @source-repo/continuity

What a [Source RPC](https://github.com/source-repo/rpc) component keeps when the process implementing it is replaced: versioned state snapshots, adjacent forward migrations with reviewed defaults, the work a running activation was holding, and a record of every value that moved — and then the replacement itself, under a fence.

**Phases 1 to 3 of the online-change design.** A component is a logical thing with a persistent address; the process implementing it is not. What is here takes one process out and puts another in while callers keep talking to the same name, or refuses and says exactly why. What is not here is doing it across languages, which needs a canonical contract rather than two class layouts that happen to agree — that is Phase 4.

## Why held state is explicit

A logical component outlives any one activation of it. The values it carries between handlers cannot live only in a process's object layout, its closures or its stacks, because none of those can be handed over — so they are captured explicitly, versioned explicitly, and named by what they contain.

That rule is enforced rather than documented: state is `structuredClone`d before every migration step, and state that cannot be cloned is refused with the reason. A closure in a state field is the shape of everything that cannot survive the process holding it.

## A snapshot says what it is

```typescript
const snapshot = await sealSnapshot({
    captureKind: 'held-state-only',
    componentType: 'oven',
    componentId: 'oven3',
    sourceRevision: 'rev-1',
    stateSchemaId: 'oven.state',
    stateVersion: 1,
    stateSchemaHash: schemas.hashAt('oven.state', 1)!,
    heldState: { setpoint: 180, mode: 'heating' },
    provenance: [],
    capturedAt: '2026-03-14T09:15:00.000Z'
})
```

A snapshot found on a disk, in a bucket or in a message has to be readable without whatever wrote it being present to explain, so every question a restorer will ask is answered on the envelope — and one that cannot answer them is refused where it is written rather than where it is used.

**The two capture kinds are not degrees of completeness.** `held-state-only` says *these were the values*. `quiescent-handoff` says *these were the values, at this position in the input, under this activation, with this work outstanding*. The second is a statement about an instant, which is why a partial one cannot be written at all.

## A barrier, and one instant

A component is quiescent when nothing the runtime dispatched to it is running and nothing more will start. `holdExecution` puts a task on the serial execution queue a component's methods already run on and never resolves it, so calls that arrive queue behind it rather than being rejected — the plant keeps talking to a component that is briefly not answering, which is what makes the change online.

```typescript
const barrier = server.rpc.holdExecution('mixer')
await barrier.quiescent               // what was running finished; nothing new started
const result = await captureAtBarrier({ ... })
barrier.release()                     // whatever queued behind it now runs
```

`captureAtBarrier` refuses rather than producing a snapshot that describes no instant: `not-quiescent` if the barrier is not held, `work-in-flight` if a handler is still running, `unsafe-outbound` if a non-repeatable command is out and its outcome is unknown — the one case where neither assuming it ran nor assuming it did not is safe. **A refusal leaves the component running.** Capture does not release the barrier either, because the values and the manifest have to come from the same held instant, and anything that ran in the gap would make them describe two.

The honest limit is stated in the tests as well as here: **the barrier orders work the runtime delivered.** A component whose state is changed by a raw `setInterval`, an event handler or a direct method call did not go through the queue, and no barrier can know. That is why an *eligibility* claim is a claim about a component's code and not a property the runtime can verify.

## Obligations: what the old activation was still holding

State alone is not a handoff. A component that has a dwell timer running, a dispense command out, a lease on a hopper and a subscriber following its alarms owes four things that a successor holding only its values would silently drop.

```typescript
const ledger = new RpcObligationLedger()
ledger.register({ kind: 'timer', id: 'mix-dwell', clock: 'monotonic', dueAt: 5_000n, capturedAt: 1_000n, policy: 'preserve-remaining' })
ledger.register({ kind: 'outbound-call', id: 'dispense-7', target: 'hopper', method: 'dispense', semantics: 'non-repeatable-command', idempotencyKey: 'batch-19/dispense' })
```

The manifest may be **empty and may not be absent**. A component that owes nothing owes nothing, and saying so is a finding; a missing manifest means nobody looked, and `admissibleForHandoff` refuses it.

## Every obligation gets a disposition, and nobody may infer one

`planRestore` pairs the manifest with what the successor declares it can do, and refuses on the first thing nobody can honour rather than reporting a plan with a hole in it.

```typescript
const plan = planRestore(snapshot, [
    { id: 'mix-dwell', resolution: 'assumed', timerPolicy: 'preserve-remaining' },
    { id: 'alarms', resolution: 'reestablished', redelivery: 'at-least-once-deduplicated' }
], { now: monotonicNow() })
```

Five resolutions, and they are different claims rather than degrees of success. **`assumed`** — the successor holds the same obligation, unchanged. **`reestablished`** — it holds an equivalent one, and something observable differs. **`completed`** — it was discharged during the handoff. **`failed`** — it could not be, and whoever is owed the result is told. **`unhonourable`** — nobody can, and the handoff does not happen.

**Silence is not a claim.** An obligation the successor says nothing about is `unhonourable`, never `assumed`: a revision that has never heard of `mix-dwell` cannot be said to have preserved it, and a handoff that treated an unmentioned timer as carried across would hand a plant to a program that does not know it is holding a deadline.

**A timer has no default policy**, because every policy is right for something and catastrophic for something else — a dwell that restarts has doubled a bake, a watchdog that preserved its deadline fires the instant the successor comes up. `preserve-remaining`, `preserve-deadline`, `restart`, `fire-on-activation` and `refuse-if-overdue` are each named at the timer, by somebody who knew what that timer was for.

The same rule reaches the other kinds. A lease is carried only where its issuer knows what a logical owner is, because assuming otherwise hands the successor an authority the issuer does not believe it has. A re-established subscription must say what the transport will do to it — `exactly-once`, `at-least-once-deduplicated`, `at-least-once` or `gap-possible` — because "recreated" without that is a claim of continuity the transport underneath has not made.

## The plan is proved twice

`validateAtBarrier` re-runs the plan against the snapshot actually taken at the barrier and compares it with the one proved earlier. The earlier pass ran against whatever was current when preparation started; a component that took on work in between, or finished something, is owed a different set of things — and the moment before a cutover is the worst possible time to discover it.

## One reviewed transform per adjacent version

vK to vN applies K→K+1 through N−1→N in order. That is V−1 transforms to maintain rather than one per version pair — and, more to the point, one place per version where somebody had to decide what a new field means. A direct K→N transform is a decision nobody reviewed, taken about versions that were never adjacent.

```typescript
const step: RpcMigrationStep<OvenV1, OvenV2> = {
    id: 'oven.state/1-2/setpoint-is-celsius',
    schemaId: 'oven.state',
    from: 1,
    approval: { by: 'process engineering', reference: 'PR #412' },
    apply(state, say) {
        say.transformed('targetC')
        say.defaulted('unit', 'C', 'every oven in service at v1 was commissioned in Celsius')
        return { targetC: state.setpoint, mode: state.mode, unit: 'C' }
    }
}
```

Three outcomes, and they are not degrees of success. **`total`** — the old state determined the new one. **`defaulted`** — a value came from a decision somebody reviewed, and the record names the field, the value and the grounds. **`impossible`** — a question needs a person, and `say.impossible(path, why)` refuses the whole chain rather than inventing something nothing downstream could tell from a measured value.

`why` is not optional on a default. Six months later the question is never *was a default applied*; it is *who chose 20 °C, and against what*.

## There is no separate dry run

A dry run executing different code from the committed one proves nothing about the committed one. `migrate` is a pure function of an immutable snapshot, and a dry run is calling it and not storing the answer. Two calls over one input produce the same snapshot in every field, hash included, because nothing here reads a clock — a derived snapshot carries its parent's `capturedAt`, since deriving is not observing.

**Every step runs twice and its two outputs are compared.** That is how *transforms are deterministic* becomes a checked property rather than a rule in a document: a clock or a random value is caught by the only party in a position to catch it. There is deliberately no way to turn it off, because an off switch is what gets flipped when the check fires.

## Provenance

Every step records its id, its approval, the fields it transformed, the values it defaulted with their reasons, and the canonical hash of its input and output — so a chain can be re-walked and a snapshot four versions along can say which value was decided at v2 without the v2 snapshot being present.

## Golden snapshots

`golden/` holds one real snapshot per released state version, retained as a file rather than built by a test. A fixture the code constructs agrees with whatever the code now does, which is the one thing a regression test must not do. A golden snapshot demonstrates a known case; it does not by itself prove a transform is total.

## One logical component, two activations

```typescript
const outcome = await handOver({
    componentId: 'mixer1',
    store,                                   // the ownership record, and what it can guarantee
    successor: { activationId: 'b', revisionId: 'rev-2' },
    incumbentFence,                          // open; closed by the coordinator, after the swap
    successorFence,                          // closed; opened by the coordinator, after the swap
    buffer,
    declarations,
    clock,
    capture, releaseBarrier, restore, deliver, returnToIncumbent
})
```

`handOver` walks the design's five stages and every failure point has a stated result. **The commit point is the compare-and-swap and nothing else.** Before it, abandoning is free: the successor is discarded, the barrier released, what was buffered goes back to the incumbent, and no caller can tell a handoff was attempted. After it, the successor has been told it is authoritative and may already have touched the plant, so this coordinator will not put the incumbent back — a failure past that point is reported as one, with the record needed to recover forward.

A capture that cannot be taken is `temporarily-blocked` and two revisions that cannot be reconciled are `refused`, because they are not degrees of one thing: the first is the plant being busy and is worth retrying in a minute, and the second is a message somebody needs to read.

## Ownership is a record, and a store says what it can actually guarantee

```typescript
interface RpcActivationOwner { componentId: string; activationId: string; revisionId: string; epoch: bigint }
```

An interface-compatible replacement does not receive authority by being interface-compatible. The epoch is an ordered integer rather than the topology edge's opaque generation, because a stale write arriving at a sink needs *is this older than what I have* and only an ordered value answers that. Ownership is deliberately **not** the topology owner edge: that one rotates when somebody reparents a component, and merging them would mean a reparenting silently fenced every live activation in the plant.

`RpcOwnershipCapabilities` states `linearizable`, `durable` and `fencedAtTheSink` rather than implying them. `MemoryOwnershipStore` answers `false` to all three and is the reference implementation, not a default: "at most one activation may commit" is a claim about behaviour under partition, and a `Map` in one process cannot make it — the question does not arise until there are two processes.

## A fence has two halves, and only one of them survives a partition

The **local** half is what an activation holds. It starts in shadow — outputs disabled, so preparation can restore it and ask whether it is ready without a second authoritative activation existing — is opened after the swap, and closes one way. A fenced activation does not come back, because coming back would mean acting after its successor already did and nobody knows what happened in between.

The **sink** half is applied where the effect lands: the state store, the broker, the output gateway. It compares the epoch on the act against the epoch it has. This is the half that holds under partition, because it does not require the stale activation to know anything — and retiring A in a registry does not reach A.

An epoch *ahead* of what the sink has is refused too. `<` rather than `!==` is the tempting relaxation and it is wrong in the direction that matters: accepting an epoch the sink was never told about makes the sink's own view of ownership decorative.

## Callers address a name, not a process

`RpcActivationDirectory` keeps registration and ownership apart. Registration is where an activation can be reached — a shadow is registered, because preparation has to talk to it. Ownership is which one may act. A resolution carries the epoch it was taken under, and that epoch is its shelf life: holding the address without it is a destination that looks correct and stops being correct silently.

Deregistering is not fencing and does not pretend to be. It removes an address, which stops new callers finding it and does nothing whatever to one already talking.

## What arrives while nobody is authoritative

Between the barrier and the swap there is a window in which the incumbent has stopped and the successor has not started. `RpcInputBuffer` holds what lands there, which is why the change is online rather than an outage — a caller waits a few hundred milliseconds instead of being refused. It is **bounded**, because a stuck handoff behind an unbounded buffer is an outage of a different shape; it **preserves order**, so the successor is applied to exactly the sequence following the barrier; and it is **released once**, because a buffer released twice delivers a non-repeatable command twice.

Abandoning a handoff returns what was held to the incumbent rather than dropping it. A failed change and a lossy one are different things, and only the second cannot be recovered.

## What is not here

**Cross-language handoff.** Replacing a TypeScript activation with a C# one needs a canonical contract and state schema independent of either language's class layout — stable field identifiers, integer widths, absent versus null, enum evolution. Phase 4.

Reverse migrations. The pre-migration snapshot is what a rollback uses, and only until the new activation has begun authoritative work — after that, restoring it would lose history and might repeat effects. A reverse chain would look like a general undo and would not be one.

## License

MIT
