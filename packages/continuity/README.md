# @source-repo/continuity

What a [Source RPC](https://github.com/source-repo/rpc) component keeps when the process implementing it is replaced: versioned state snapshots, adjacent forward migrations with reviewed defaults, the work a running activation was holding, and a record of every value that moved — and then the replacement itself, under a fence.

**The online-change design, phases 1 to 4.** A component is a logical thing with a persistent address; the process implementing it is not, and it need not even be in the same language. What is here takes one process out and puts another in while callers keep talking to the same name, or refuses and says exactly why.

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

**It can, though, be caught in the act.** Every commit to a component's props or state moves its revision counter, whatever route the write took — so a component that is supposed to be quiescent and whose revision moves anyway has just demonstrated that something is changing it outside the runtime. `settleMs` on the capture request watches for exactly that long and refuses `unmanaged-mutation` rather than sealing a snapshot whose values are from after the barrier under an input position from before it.

```typescript
const result = await captureAtBarrier({ ...request, settleMs: 50 })
```

What that costs is 50 ms under the barrier on every capture, with the plant waiting — which is why it is a number the deployment chooses rather than a default somebody discovers. And it detects *mutation*, which is not the same as detecting unmanaged work: an unregistered timer due in an hour touches nothing during the window. What it catches is the case that actually corrupts a snapshot.

## Obligations: what the old activation was still holding

State alone is not a handoff. A component that has a dwell timer running, a dispense command out, a lease on a hopper and a subscriber following its alarms owes four things that a successor holding only its values would silently drop.

```typescript
const ledger = new RpcObligationLedger()
ledger.register({ kind: 'timer', id: 'mix-dwell', clock: 'monotonic', dueAt: 5_000n, capturedAt: 1_000n, policy: 'preserve-remaining' })
ledger.register({ kind: 'outbound-call', id: 'dispense-7', target: 'hopper', method: 'dispense', semantics: 'non-repeatable-command', idempotencyKey: 'batch-19/dispense' })
```

The manifest may be **empty and may not be absent**. A component that owes nothing owes nothing, and saying so is a finding; a missing manifest means nobody looked, and `admissibleForHandoff` refuses it.

## Doing the work and recording it are one act

The two calls above are the low level, and everything that can go wrong with two calls does: the command goes out and the register does not, so the manifest says the component owes nothing while a hopper is dispensing; the timer fires and nothing completes it, so the successor is handed a deadline that has already passed. A manifest that is *nearly* complete is worse than none, because the successor is told it assumed everything.

`RpcManagedRuntime` closes that gap by not having it. There is no order of statements in which the timer is armed and the obligation is not, because arming it is registering it.

```typescript
const runtime = new RpcManagedRuntime({
    componentId: 'mixer1',
    dispatch: dispatchOn(server.rpc, 'mixer'),   // the instance's own serial chain
    monotonic: () => process.hrtime.bigint() / 1_000_000n
})

runtime.setTimer({ id: 'mix-dwell', afterMs: 5_000, policy: 'preserve-remaining' }, () => mixer.finishDwell())
await runtime.call({ id: 'dispense-7', target: 'hopper', method: 'dispense', semantics: 'non-repeatable-command' }, () => hopper.dispense(7))
```

**A managed timer's callback runs on the component's chain**, through `RpcServerHandler.runInOrder`, and that is the half that a wrapper for tidiness would miss. A `setTimeout` fires wherever the event loop delivers it — including in the middle of a capture, writing state after the component was declared quiescent, which is a snapshot describing an instant that never existed. Dispatched through the chain, a timer that comes due while a barrier is held simply queues behind it.

Which is also why **a timer that has fired is not struck off until its callback has actually run.** Between the handle firing and the work happening there is a queue, and while a barrier is held that queue is where the callback sits: a capture taken there must show the timer as outstanding and overdue, and let the successor's declared policy decide what a missed deadline meant.

A `non-repeatable-command` whose failure **may have run** — `UnknownOutcome`, `Timeout` — deliberately stays on the books, which is what makes the next capture refuse `unsafe-outbound`. The ledger is the only thing holding the fact that nobody knows whether the hopper dispensed, and the only thing that can end that is evidence from outside the program: `runtime.discharge('dispense-7')` after a reconciliation read, never a timeout.

`close()` is one-way and clears every armed handle, because a retired activation whose timers still fire is the failure the fence exists to prevent arriving by a route the fence does not cover. **It does not empty the ledger.** Closing is about not acting; what this activation was holding is precisely what the successor is being handed.

None of this makes eligibility checkable. What it does is let a revision that claims `runtimeManagedObligations` in its manifest have earned the claim, rather than only having made it.

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

## Leaving the language

`toPortable` and `fromPortable` are the form a snapshot takes when it is written down, and `SourceRpc.Continuity` is what reads it at the other end. One property carries the rest: **a snapshot written here verifies to the same content hash there.** The fixtures in `packages/conformance/fixtures/continuity` are read verbatim by both suites, because two implementations that both compute a digest are not two implementations of one digest until a single file has been asked of both.

**Positions cross as decimal strings.** JSON has one numeric type and it is an IEEE-754 double: `lastAppliedInputSequence` past 2^53 rounds, silently, and a successor that starts at a rounded position reprocesses input or skips it — with no indication at the time and no way to tell afterwards which happened. A position that arrived as a JSON *number* is refused rather than converted, because nothing at that point can tell whether the value survived and converting it would launder a rounding error into an authoritative sequence position.

**Held state must be portable, which is stronger than cloneable.** Phase 1's rule was that state must survive `structuredClone`, because a closure cannot be handed to another process. This one is that it must survive JSON: a `Date`, a `Uint8Array`, a `Map` and a `bigint` all clone perfectly and none of them cross a language boundary as themselves. `toPortable` refuses, names the path, and says what to hold instead — a component that wants to be replaceable by one written in another language holds its state in the vocabulary its declared schema can describe.

## A revision says what it is

```typescript
const manifest = await sealManifest({
    componentType: 'mixer',
    revisionId: 'dotnet-rev-2',
    artifactType: 'dotnet',
    artifactHash: 'sha256-…',
    contract: { id: 'mixer', version: 2, schemaHash: '…' },
    state: { schemaId: 'mixer.state', version: 2, schemaHash: '…' },
    requiredCapabilities: ['plant.write', 'hopper.lease'],
    onlineChange: { supported: true, serialisedHandlers: true, runtimeManagedObligations: true, quiescenceDeadlineMs: 2000 }
})
```

Across languages nothing is checked by anything unless it is written down. Two artifacts that share no compiler, no type system and no runtime share a component type, a contract hash and a state schema hash — and if those agree the successor holds the same description of the same values. `reconcile` says whether they do, and reports a state *version* difference separately from a mismatch of identity, because the first is what migration is for and the second is never migratable.

**The manifest describes the revision. It does not grant authority.** It is emitted by the artifact, and an artifact that could authorise itself by asserting its own capabilities would make the approval path decorative. `authorised` measures it against an identity policy the deployment owns, and refuses with four different sentences because they are four different conversations: the wrong type is a mistake, an unapproved artifact needs a deployment approval, a capability outside the envelope needs the envelope widened by whoever owns the identity, and an identity not eligible for online change needs a controlled restart instead.

## What a component did between the instants

The obligations manifest says what a component was doing at the instant of its snapshot. That is one instant. Answering *what was it doing at 03:14?* needs an append-only record of what happened between them — and the design is explicit that a handoff snapshot alone must never be treated as one.

The sharper reason is `failed-after-commit`. The coordinator ends a handoff that failed past the commit point with the words *recover forward*, and until there was a journal those words were an instruction rather than something anybody could carry out.

```typescript
const outcome = await recoverForward(record, snapshot, await journal.read('oven3'), 'suppress-effects')
if ('refused' in outcome) return tellSomebody(outcome.refused)
await replay(outcome.plan, (entry) => successor.apply(entry.payload))
```

**A snapshot and a journal join at one number.** `lastAppliedInputSequence` says where the snapshot stopped; replay begins at the entry after it. Inputs the snapshot already contains are not applied again, and a snapshot with no input position — a `held-state-only` capture — has nothing to replay onto and says so.

**A gap refuses.** A journal missing input 41 can still apply 42 onwards, and the state that results never existed in the plant: it is the state of a component that received one fewer command than it did. That looks exactly like a recovery, which is why it is refused rather than reported. A replay that fails part-way stops at the input the successor could not take and says how far it got, for the same reason.

**Effects are declared and there is no default.** `suppress-effects` rebuilds the successor with its outputs fenced — re-applying a hundred inputs re-runs a hundred handlers, and one that commanded a valve will command it again. `honour-idempotency` lets them out under their recorded keys, which is safe only where the sinks actually deduplicate, and that is a claim about the plant rather than about this library.

**It chains.** Every entry carries the hash of the one before it and of its own content, so a journal verifies end to end: an entry altered in place fails its own hash, and one removed from the middle breaks the link. A record of what a plant did is evidence, and evidence that cannot be checked is testimony.

**Retention is not an age.** `compactTo` takes a snapshot rather than a date, because a journal is long enough exactly when it reaches from a snapshot somebody kept to now. It discards what that snapshot already contains and **refuses** where it would leave a journal that still looked whole and could no longer carry the snapshot it was kept for.

`RpcMemoryJournal` answers `durable: false`, like `MemoryOwnershipStore` before it. It can carry a failed handoff forward, which takes seconds, and it cannot answer anything about last night — both true, and only one of them is what somebody means when they ask for a journal.

**And another language reads it.** `oven-journal.json` in `packages/conformance/fixtures/continuity` is read verbatim by this suite and by `SourceRpc.Tests`, and both compute the same chain of hashes over it and reach the same replay plan from the same snapshot. That is a stronger claim than the snapshot's: a snapshot hash is over one document, and a chain is over every document and the order they are in.

## What is not here

Reverse migrations. The pre-migration snapshot is what a rollback uses, and only until the new activation has begun authoritative work — after that, restoring it would lose history and might repeat effects. A reverse chain would look like a general undo and would not be one.

## License

MIT
