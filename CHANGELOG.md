# Changelog

## Unreleased

### A component can be stopped dead, and the thing that stopped it keeps answering

A feasibility prototype for the diagnostics design's third phase, built before anything was built on it. Phase 3 asks for an isolated pausable logic worker and a supported runtime pause gate, and whether this runtime can honestly provide either is a question better answered with a working gate than with a plan. `RpcPauseGate` is that gate. **It is not a breakpoint** - no supervisor protocol, no controller lease, no stepping - so `exactPause` and `stepping` are still advertised `false` and nothing a viewer can ask for has changed.

`Atomics.wait` parks a worker's JavaScript thread in the kernel: not a promise that resolves later, the thread itself, with its microtasks, its timers and its socket callbacks all stopped. That is what *the component logic execution context is blocked* has to mean, and it is why the supervisor cannot live on that thread. The supervisor side uses `Atomics.waitAsync`, which returns a promise instead of parking - a supervisor that blocked to wait for a pause would have suspended the only thing capable of ending it.

Every test runs a real worker thread, because every claim is about threads and a promise-based imitation would pass all of them while proving nothing. **A resume continues the same stack**: the handler is entered once, parks once, and carries on - `['entry:released', 'clamped=300:ran-through', 'doubled=600:ran-through']` - which is the design's second acceptance criterion and the thing that separates an exact breakpoint from re-running a handler and hoping it takes the same path. A pause nobody ends ends itself on the parked thread's own deadline, reporting `expired` rather than `released`, because the failure being guarded against is precisely the supervisor being gone.

Measured rather than asserted: the fast path is one `Atomics.load` at about 5 ns per arrival, against 1 ns for a plain read and 0.36 ns for an empty loop. Twenty statements cost 100 ns, which is nothing beside the RPC that called them; a million-iteration loop with a gate in its body costs 5 ms, which is not. Probe budgets should be about *where* probes go and not only how many.

**The limits are the reason for building this first**, and they are written up in `notes/exact-pause-feasibility.md`. The one that decides the shape of the phase: a parked thread freezes everything sharing it, so a pause scope of one component means one worker per component - a node with fifty components paying fifty threads - or pausing one component stops its neighbours, which is a very different thing to advertise. Deadlines do not pause while timers inside the paused thread do, so a component that watches itself stops watching itself the moment it is paused. Requesting a pause is not stopping: the thread parks at its next gate, and a handler that reaches no further probe cannot be paused at all.

And the finding that matters for planning: the expensive part is not the gate. Today `RpcServer` holds the transport and its components on one thread, so making components pausable means moving component logic into workers and passing calls across a thread boundary - an architectural change to `@source-repo/rpc`. Stepping, by contrast, needs no new mechanism at all: it is this gate with a frame-depth predicate over the entry and exit probes that already exist.

### A tracepoint captures without stopping, and its condition may not do anything

The last of diagnostics Phase 2. A tracepoint watches a line, captures named locals when a condition holds, and emits an event without pausing the component - the mode the design calls appropriate to the widest range of nodes, and the only one of its three this package implements, because the other two stop a plant.

**The condition is the whole risk, and the grammar is the whole answer.** It is compiled into the verified derivative, which the design allows, and it runs *inside the component* - on its stack, between its statements, every time the probe is reached. So `queue.pop() > 3` would empty a queue in order to decide whether to mention it, and here is the part that makes this a design problem rather than a code-review one: strip the probe afterwards and the program is byte-identical, so the derivative proof passes and the plant has still been running something nobody approved. Nothing downstream can catch it. The transformer therefore checks every condition against a constrained grammar before emitting it - comparisons, logical operators, property access, literals, and nothing that calls, assigns or increments - and refuses at build time, where a person can be told which expression and why. Every identifier must be one of the captured locals, so a condition cannot reach a global; and a capture list is checked against the function's own parameters and declarations, so it is not a way to read one either.

**Counting and capturing are different things.** Every hit is counted whether the condition held or not, because *this line ran four thousand times and the condition never held* is an answer, and a probe that recorded nothing when it did not capture would be indistinguishable from a line that was never reached.

**What needs a rebuild and what does not follows the design's split exactly.** A condition is compiled in, so changing it means building a new variant. A hit count and a message template are the sink's, so changing them does not - a plant is not swapped to reword a message. A `{placeholder}` naming something that was not captured is left as written rather than becoming `undefined`, since *this was empty* and *you did not ask for this* are different things to somebody reading at speed, and a withheld field renders as its marker inside the message too: a template is not a way around a classification.

Installing one answers to `create-tracepoints` rather than to `request-probes`, because it compiles code into the artifact rather than reading what is already there - and a session asking for one without holding it is degraded with the reason, like every other mode. Captures are bounded, what the bound discarded is counted, and they reach the session that installed the tracepoint and no other.

`tracepoints` is now advertised true where a node has both a sink and variant activation, since a tracepoint needs somewhere to write *and* a way into the artifact. `safeBoundaryPause`, `exactPause` and `stepping` remain false: those stop a component, and stopping is Phase 3.

### What the probes saw, and who is allowed to see it

The telemetry half of the diagnostics design's second phase, which was left until the authority model could arrive with it. Serving probe samples is a second data path in a way the source catalogue never was - a component's props were always observable and its locals never were - so this lands as an observation session with permissions, a deadline and a bounded publication rule, rather than as a method that returns the buffer.

**Twelve permissions, because there are twelve conversations.** Being allowed to see a component's props is not being allowed to see its locals; seeing locals is not being allowed to change the artifact by activating an instrumented build; and watching a value is not `retain-recordings`, which is what an ordered trace actually asks for, since watching is transient and a trace is a copy. They are checked one at a time, and a caller holding some of them gets a **degraded session** naming what it did not get - the design's fallback rule - rather than a refusal. What is refused is a session that could serve nothing: falling back to nothing is not a fallback, and a session reporting itself healthy in front of an empty screen cannot be told apart from a component that has not run yet.

**There is no default authoriser, and the capability set follows the pair.** A node given a sink but no authoriser, or an authoriser but no sink, serves no sessions and advertises no probe capabilities. A package cannot decide on a deployment's behalf that watching a plant's locals needs no permission, so it refuses and says why.

**A table, not an event per hit.** A statement in a loop at a hundred hertz produces six thousand events a minute and one useful fact, so the latest value per probe and its execution count go in state, sized by how many probes exist rather than by how often they fire. The dropped count is published beside the values, because a gap a viewer cannot see is a lie. An ordered trace is an event and goes only to a session that asked for one and was permitted to keep it. `publish()` is called by the host rather than by a timer in the package: a library that started its own interval would be setting a plant's publication rate.

**A classified field is withheld at capture rather than in the editor**, which is the design's rule and the only place it can be true - a value redacted on its way to a screen has already been in a buffer, in a message, and in whatever logged either. The probe still fires and is still counted, so the execution path stays visible while the value never enters diagnostic memory.

**A session expires.** A disconnect is not distinguishable from a slow viewer at this level, so a deadline ends a session rather than a socket, clamped to what the node allows - which is what stops a plant being left instrumented because somebody closed a laptop. An update may move the viewport and renew the deadline; it may not widen the modes, since those were decided against this caller's permissions when the session started, and an update that could grant one would make the authorisation something that happened once to a request that has since changed.

Tracepoints, breakpoints and stepping remain `false`.

### The instrumented copy takes over, and the plant does not notice

The diagnostics design's section 16 is `handOver` step for step, and this is the commit that says so in code: shadow activation with output fenced, the normal quiescence barrier, capture, restore of the identical state schema with no migration, obligations re-established under the ordinary rules, and one atomic epoch swap. `@source-repo/diagnostics` gains a dependency on `@source-repo/continuity`, which the workspace build order already anticipated.

**Instrumenting a component is not a special way of replacing it.** It is the ordinary way of replacing it with something that was proved to be the same program - so there is no diagnostic handoff protocol, and the only thing this adds ahead of the coordinator is the proof. Which runs *first*, while the base activation is still going: a variant that could never be activated costs nothing, because the component is never quiesced for it. A handoff refused at the barrier has already stopped a plant.

**This is the one handoff where blanket `assumed` is a conclusion rather than an assumption.** Everywhere else, a successor that says nothing about an obligation is refused - a different revision cannot be presumed to know what `mix-dwell` was for. Here the successor was proved to be the same program plus probes, so it knows every obligation by the same id, and `declarationsForVariant` reports that proof. What no proof settles is what a timer should do about the handoff window, so the policy is still asked for by name. An obligation taken on after preparation is not covered, and `planRestore` refuses on it at the barrier - which is the design's *final validation is repeated against the barrier snapshot* earning its place.

**A paused activation is refused, before anything can pause.** It is not quiescent, so it cannot reach a barrier and cannot be replaced. Encoding it now costs one branch; discovering it when the first breakpoint exists costs a handoff hanging on a barrier that can never be reached.

**A variant imports `__rpcProbe`, so that had to become something.** `RpcProbeSink` is it, and it is deliberately dull because it runs between statements that control machinery: it never throws into component logic, returns the observed value by identity, is bounded by a ring and a byte cap with its drops visible, renders values at capture rather than holding references, and never awaits or reaches the network, the filesystem or the plant. A getter that throws becomes `unrepresentable` on the sample rather than an exception on the component's stack.

**Capabilities are now derived from what the host wired rather than declared.** `diagnosticVariants` is true when a deployment has an ownership store, fences and a coordinator; the probe flags are true when there is a sink, because generating a value probe is not the same as being able to say what it saw. Two nodes running this same build can honestly answer differently, and a package that guessed would advertise what the deployment never arranged. `tracepoints`, `safeBoundaryPause`, `exactPause` and `stepping` remain `false`.

What is still not here is the telemetry transport. Samples land in an in-process sink and are read by whoever holds it; serving them over Source RPC is a second data path in a way the source catalogue never was, since locals are not otherwise observable, so it waits for the observation session and the authority model rather than arriving as a convenience method.

### Probes generated into a copy of the source, and the program still does what it did

The other half of the diagnostics transformer, written second on purpose. `instrumentSource` produces the derivatives that `provesDerivative` was already able to refuse, and every test it has ends by handing its output to the verifier - a generator that also defined what counted as correct would be marking its own homework. It emits all six probe kinds: entry, exit, statement, value, condition and branch.

**A viewport becomes the containing function**, which is the design's default unit rather than a convenience. A viewport begins in the middle of a condition as often as not, and instrumenting from there would put an entry probe inside an expression. It also settles what happens while somebody scrolls: a plan built for a function does not change because two more of its lines came into view, so the variant already running stays the right one, and two viewports over one function are one region.

**Spans are recorded from the approved source before emit**, because the person reading is looking at the approved file and not at the instrumented copy - a span measured after emit would position a value using coordinates from a file nobody can see. Probe ids are derived from those positions rather than counted, so the same source produces the same plan however the walk reached it, and an edit that moves a line moves the id, which is the design's rule about cross-revision stability stated in the id itself.

**Unavailable rather than uncertain**, which is the design's rule and shaped everything here. An initialiser holding a function body is reported rather than wrapped: the arrow inside it is instrumented as its own region, and a probe around it would have to be rewritten as another probe rewrote its inside. A single-statement `if` branch is reported rather than given braces, because adding braces is a change to the program even where it reads as the same one. Loops and `try` bodies are probed as the statements they are - a coverage limit, stated, rather than an equivalence risk.

**The invariants are tested by running the code.** *Evaluated exactly once* and *short-circuit preserved* are claims about execution, and no comparison of syntax trees tests them - so the suite executes each snippet twice, once plain and once instrumented against a recording stub, and compares what the program did. Two bugs came out of writing those tests rather than out of reading the code. A `wrappable` check that only looked at descendants let an initialiser that *was* an arrow through, so the wrap and the arrow's own probes overlapped and the artifact came out corrupt. And returns were probed only at the top level of a body, so a `return` inside an `if` produced a function that entered and never left; returns are now found by their own scan at every depth, which also covers the loops and `try` bodies the statement walk does not descend into.

**The evidence seam moved, and this is the commit that moved it.** `RpcDerivativeEvidence` carried one list of probes when only the verifier existed. Now that a planner exists it carries two, because they are two different things: `plan` is what a reviewer approved and a viewer is served, with spans in the approved source, and `found` is what the strip located in the artifact, by identity and kind. Neither can be derived from the other, and comparing them is the check - a probe in the artifact that no plan names is an observation point nobody reviewed, and a plan naming a probe the artifact lacks is an overlay that will never fire while looking exactly like one that has not been reached yet.

`diagnosticVariants` is still `false`. Nothing here activates anything.

### A diagnostic variant can be proved to be one, which is not building one

The diagnostics design's second phase generates probes into a node's own source and runs the result. It opens with one line - *depends on state-preserving component replacement* - and that dependency is now met: its section 16 is `handOver` step for step, down to starting the variant as a shadow with output fenced and restoring the identical state schema without migration.

What is built here is the check that has to exist before anything generates a variant, in the order the handoff work ran in. A rule written after the thing it governs is a rule written to fit it.

**The claim a variant makes is that it is the approved source plus probes, and nothing about a build checks that.** A transformer with a bug, a hand-edited artifact and a deliberately altered one all produce a file that compiles and runs on a plant. So the check is the reverse operation - strip every recognised probe and see whether what is left is the approved program - and it is the reverse operation precisely because it does not trust the forward one. The test that matters is the one where a single literal changed inside an expression a probe wraps: every probe in that file is perfectly well formed, and the digests disagree.

**What counts as a probe is defined by the verifier, not by the generator**, which does not exist yet and deliberately so. A probe is a call on the reserved receiver `__rpcProbe` in one of six recognised shapes. `value` and `condition` wrap the observed expression and evaluate to it, so it appears exactly once and the design's *evaluated exactly once, with unchanged results and exception behaviour* becomes a property of the shape rather than a promise about a generator. Anything else mentioning the receiver refuses: a strip that skipped what it did not recognise would leave it in the output and report *the transformer changed the program*, which is true and points at the wrong thing, and one that deleted everything mentioning the receiver would delete code somebody wrote.

**The node holds hashes; the compiler does the walk.** `admissibleVariant` is in `@source-repo/diagnostics`, whose dependency list is still one line, and the strip is in `@source-repo/rpc-cli` where ts-morph already is - the same split the binding catalogue makes, and for the same reason: giving every node a TypeScript compiler in order to decide whether to accept a build would put the whole toolchain inside the plant. Seven rules, refusing on the first, each in its own sentence because they are seven different conversations. The only capability a variant may add is `diagnostics.telemetry`; anything else is an artifact using instrumentation to widen its own authority.

Programs are compared reprinted from their parse trees, so formatting is not a difference and **comments are not part of the comparison** - a probe legitimately arrives with one attached. That has a cost worth naming rather than hiding: a variant may change a comment and this will not see it. What it exists to catch is a changed program, and a comment cannot be one.

`diagnosticVariants` is still advertised as `false`. Verification is not activation, and a capability flag that ran ahead of the code would be the one thing the capability set exists to prevent.

### Arming a timer and owing it are one act

Phase 2 of the online-change design asks for runtime-managed timers, calls, subscriptions, publications, leases and sequences. What existed was a ledger and the instruction to call it, which is two acts - and everything that can go wrong with two acts does. The command goes out and the register does not, so a manifest taken a moment later says the component owes nothing while a hopper is dispensing. The timer fires and nothing completes it, so the successor is handed a deadline that has already passed. A manifest that is *nearly* complete is worse than none, because the successor is told it assumed everything.

**`RpcManagedRuntime` has no order of statements in which the timer is armed and the obligation is not.** Arming it registers it, the call is on the books from before it is sent until after it is answered, and an inbound handler clears itself in a `finally` rather than on every path out including the ones that throw.

**A managed timer's callback runs on the component's own serial chain**, which is the half a wrapper written for tidiness would miss. `RpcServerHandler.runInOrder` is new and is where it goes: a `setTimeout` fires wherever the event loop delivers it, including in the middle of a capture, writing state after the component was declared quiescent - and the snapshot then holds values from after the barrier under an input position from before it. Dispatched through the chain, a timer that comes due while a barrier is held queues behind it, exactly as an arriving call does. It is counted in `waiting()` for the same reason and deliberately not bounded by the mailbox: a caller refused `Busy` can decide what to do, and a timer this component set has nobody to tell.

**A timer that has fired is not struck off until its callback has actually run.** Between the handle firing and the work happening there is a queue, and under a barrier that queue is where the callback sits. Completing the obligation when the handle fired would hand over a manifest saying nothing was pending while a callback waited to run in a process about to be retired; left outstanding, it reaches the successor as the overdue timer it is, and the policy that revision declared decides what a missed deadline meant. If the swap commits first, the fence the runtime holds stops the callback from ever running - and the obligation still travels, because closing is about not acting and not about forgetting what was owed.

**A `non-repeatable-command` whose failure may have run stays registered on purpose**, which is what makes the next capture refuse `unsafe-outbound`. `mayHaveRun` already classified `UnknownOutcome` and `Timeout` for the operation tray, and the same classification decides this: the ledger is then the only thing holding the fact that nobody knows whether the hopper dispensed. `discharge` is how that ends, and it takes evidence from outside the program - a reconciliation read, a device that reports what it did, somebody who went and looked. A timeout cannot discharge it, because the whole content of an unknown outcome is that time passing tells you nothing.

**An unmanaged write is now caught in the act rather than only claimed against.** The barrier orders work the runtime dispatched, and a raw `setInterval` never went through it - that limit does not go away. But every commit to a component's props or state moves its revision counter whatever route the write took, so a component held at a barrier whose revision moves anyway has just demonstrated that something is changing it from outside. `settleMs` on the capture request watches for that long and refuses `unmanaged-mutation`. It costs exactly that long under the barrier with the plant waiting, which is why it is a number the deployment chooses and not a default somebody discovers, and it detects mutation rather than unmanaged work - an unregistered timer due in an hour touches nothing during the window. What it catches is the case that actually corrupts a snapshot. A component with no revision counter behind it refuses to be watched rather than passing a check that ran on nothing.

**A timer's remaining time is now measured from the capture.** `manifest(at)` stamps every timer's `capturedAt` with the reading the manifest was taken at, because remaining is `dueAt - capturedAt` and a `capturedAt` left at registration time gives the successor the timer's *original duration* under the name of what was left - a dwell three minutes into its five would resume with five, and nothing downstream could tell. Omitted, obligations are reported exactly as registered, which is what a caller keeping its own clock wants.

None of this makes eligibility checkable, and the manifest still says so: `runtimeManagedObligations` and `serialisedHandlers` remain claims a revision makes about its own code. What changed is that a revision making them can now have earned them.

### A .NET revision can take over from a TypeScript one

The fourth phase of the online-change design, and the acceptance criterion it sets is a .NET activation replacing a TypeScript activation under the same logical identity, state, contract, sequence position and authority envelope. The whole thing rests on one property, and everything else here exists to make that property true or to check it.

**A snapshot written by one language verifies to the same content hash in the other.** Two implementations that both compute a digest are not two implementations of one digest until a single file has been asked of both and the answers compared - so `packages/conformance/fixtures/continuity` holds three documents, read verbatim by the TypeScript suite and by `SourceRpc.Tests`, and neither generates them. The handoff fixture carries every obligation kind, because a port that had forgotten one would otherwise return an empty group and read as *the incumbent owed nothing of that sort*.

**Positions cross as decimal strings, and one that arrived as a JSON number is refused rather than converted.** JSON has one numeric type and it is an IEEE-754 double. `9007199254740993` - the smallest integer a double cannot represent - round-trips as `9007199254740992`, silently, and a successor that starts at a rounded sequence position reprocesses input or skips it, with no indication at the time and no way to tell afterwards which happened. Nothing at the point of reading can tell whether a given value survived the trip, so converting it would launder a rounding error into an authoritative position. The fixture carries three such values on purpose, and a reader that treats them as numbers passes every other check in the directory and fails that one.

**Held state must be portable, which is stronger than cloneable.** Phase 1's rule was `structuredClone`, because a closure cannot be handed to another process. This one is JSON, because a `Date`, a `Uint8Array`, a `Map` and a `bigint` all clone perfectly and none of them cross a language boundary as themselves. `toPortable` walks the state and refuses with the path and what to hold instead - a `JSON.stringify` that succeeded would prove nothing, since it turns a `Date` into a string and a `Uint8Array` into an object with numeric keys, both silently, and the value that comes back is not the value that went in.

**Nothing is defaulted on the way in.** An unknown capture kind, an unknown timer policy, a snapshot format ahead of the reader, a `semantics` this implementation does not know: each is a refusal naming the field. A reader lenient enough to take the document is lenient enough to take one that says something else, and this runs in a process about to become authoritative for plant. The timer policy is the sharp case - there is no default because every policy is right for something and catastrophic for something else, so one guessed at is a plant behaviour nobody chose.

**The revision manifest is new, and it describes rather than grants.** `RpcRevisionManifest` carries what an artifact claims: component type, contract hash, state schema hash, required capabilities, and whether its handlers are serialised - the claim the barrier rests on, which no runtime can verify and which Phase 2 could only record as a limit in a test. `reconcile` measures it against a snapshot; `authorised` measures it against an identity policy the deployment owns. Four separate refusals rather than one, because they are four different conversations - the wrong type is a mistake, an unapproved artifact needs a deployment approval, a capability outside the envelope needs whoever owns the identity to widen it, and an identity not eligible for online change needs a controlled restart.

**Silence is not a claim, and it matters more here.** A .NET revision has no compiler in common with the TypeScript one: everything it knows about the incumbent's outstanding work is what the snapshot says, and every disposition it claims is a claim. The C# restore rules refuse an undeclared obligation exactly as the TypeScript ones do, against the same fixture.

**`RpcCanonical` moved from `SourceRpc.Query` to `SourceRpc`, and `SourceRpc.Query` is 0.2.0.** A second consumer arrived that must not pay for the first: `SourceRpc.Continuity` verifies a content hash, and reaching the encoder through the query package would drag Polly and FusionCache into a process whose whole job is to read a file. A forwarder was tried first and is worse - with `using SourceRpc;` and `using SourceRpc.Query;` both present, which is every real consumer of that package, two types of the name are visible and every call site becomes CS0104. Removing it is source-compatible for anyone who already has `using SourceRpc;`, which this repository's own test suite demonstrates by continuing to compile unchanged.

**`SourceRpc.Continuity` 0.1.0** takes no dependency beyond the core, deliberately: it runs in the process about to become authoritative for a piece of plant, and the fewer things that must load correctly before it can say *no*, the better. It is in the release workflow and the smoke test, which now installs it from a clean cache and reads a snapshot with it.

Twenty-eight rules checked against builds with the rule removed, in both languages. Four of those runs came back green and should not have: a `Date` assertion that also matched the class-instance message it fell through to, a manifest ordering rule that only the sealing path exercised, and two C# refusals - an unknown capture kind and a redefined schema version - with no test at all. The escaped bug behind them was real: the obligation walk converted only top-level integers, so `periodic.interval` would have crossed as a bigint and thrown, and `sequence.position` would have come back as text.

What is still not here is the design's other half of Phase 4 - a journal and replay-assisted recovery, which is what would turn Phase 3's *recover forward* from an instruction into a procedure.

### One process out, another in, and callers never learn the difference

The third phase of the online-change design, and the one that actually replaces something. Phase 2 could prove a handoff admissible; this performs it, or refuses at a named stage with the incumbent exactly where it was.

**The commit point is the compare-and-swap and nothing else.** That sentence is the specification of the coordinator, because the failure table's rows are not equally obvious. Everything before the swap has one required result - the incumbent remains the owner, the barrier is released, whatever was buffered goes back, and no caller can tell a handoff was attempted. Everything after it has a different one: the successor has been told it is authoritative and may already have opened a valve, so restoring the incumbent's snapshot would silently discard what the successor did and might repeat effects that already happened. `handOver` will not do it. A failure past the commit point is reported as `failed-after-commit` with the epoch the successor holds and the record needed to recover forward.

**A capture that cannot be taken is `temporarily-blocked`; two revisions that cannot be reconciled are `refused`.** Not degrees of one thing. The first is the plant being busy - a handler running, a command out with an unknown outcome - and is worth attempting again in a minute. The second is a message somebody needs to read. An operator who cannot tell them apart retries both, and only one of them is worth retrying.

**Ownership is its own record and deliberately not the topology owner edge.** `RpcTopologyRecord.ownerEpoch` is a generation on a logical *scope* link and rotates when somebody reparents a component; an activation epoch rotates when a process is replaced. Merging them would mean a reparenting silently fenced every live activation in the plant, and a handoff silently broke every standing caller fence. They travel at different speeds because they answer different questions. The activation epoch is an ordered integer rather than an opaque generation, because a stale write arriving at a sink needs *is this older than what I have* and only an ordered value answers that.

**A store states what it can guarantee rather than implying it.** `linearizable`, `durable`, `fencedAtTheSink` - and `MemoryOwnershipStore` answers `false` to all three. "At most one activation may commit state or output" is a claim about behaviour under partition, and a `Map` in one process cannot make it: the question does not arise until there are two processes. A coordinator that inferred linearizability from the presence of a `compareAndSwap` would produce exactly the reassuring log line a split brain needs in order to go unnoticed. The precedent is `RpcTopologyCapabilities`, and the reason is stronger here.

**A fence has two halves and they catch different failures.** The local half is what an activation holds: it starts in shadow with outputs disabled - so preparation can restore the successor and ask whether it is ready without a second authoritative activation ever existing - opens after the swap, and closes one way. A fenced activation does not come back, because coming back means acting after its successor already did. The half that matters is at the **sink**: the state store, the broker, the output gateway compare the epoch on an act against the epoch they have. That one holds under partition, because it needs the stale activation to know nothing - which is the whole point, since a partitioned activation is precisely the one that never heard. An epoch *ahead* of the sink is refused too: `<` rather than `!==` is the tempting relaxation and it makes the sink's own view of ownership decorative.

**The incumbent is fenced before the successor is opened.** The other order compiles, passes every other test, and leaves a window in which two activations are both authoritative - short, and exactly as long as the moment when both processes are running and reachable. Sampling before and after cannot catch it, so the test observes the transition itself.

**Callers address a name.** `RpcActivationDirectory` keeps registration - where an activation can be reached, shadows included - apart from ownership, which is who may act. Collapsing them would make the shadow unaddressable during the one phase that has to talk to it. A resolution carries the epoch it was taken under, and that epoch is its shelf life; the address without it is a destination that looks correct and stops being correct silently. Deregistering is not fencing and does not pretend to be: it stops new callers finding an activation and does nothing at all to one already talking to it.

**What lands in the window is buffered, not refused** - that is what makes the change online rather than an outage, and a caller waits a few hundred milliseconds instead of getting an error. Bounded, because a stuck handoff behind an unbounded buffer is an outage of a different shape, with memory climbing and nobody told. Ordered, so the successor is applied to exactly the sequence following the barrier. Released once, because twice would redeliver a non-repeatable command. And abandoning a handoff hands what was held back to the incumbent rather than dropping it: a failed change and a lossy one are different things, and only the second cannot be recovered.

Twenty-two rules checked against builds with the rule removed, against two real servers rather than a model of the protocol - one of which caught a comment claiming an ordering was asserted when it was not.

### A handoff can now be *proved admissible*, which is not the same as performed

The second phase of the online-change design. Phase 1 could take a component's values across a schema change; what it could not do was say what the running activation was still holding, so `admissibleForHandoff` refused. It no longer refuses by construction — it refuses when nobody has looked.

**A barrier is not a new subsystem.** A component's methods already run on a serial execution queue, so `server.rpc.holdExecution(path)` puts a task on that queue and never resolves it. Calls that arrive queue behind it rather than being rejected, which is the whole difference between an online change and an outage: the plant keeps talking to a component that is briefly not answering. `quiescent` resolves when what was running has finished, `waiting()` says how many are stacked up behind, and `release()` lets them go. A path declared `parallel` or given a custom execution strategy is refused outright, because a barrier that held some of a component and not the rest would produce a snapshot of no instant at all.

**The values and the work come from the same held breath.** `captureAtBarrier` reads the state and the obligations without releasing the barrier, and refuses rather than producing something that describes two moments: `not-quiescent` if the barrier is not held, `work-in-flight` if a handler is still running, `unsafe-outbound` if a non-repeatable command is out with an unknown outcome — the one case where neither assuming it ran nor assuming it did not is safe, which is the founding `TransportError`/`UnknownOutcome` distinction arriving where it finally has teeth. A refusal leaves the component running.

**The honest limit is written down and tested rather than glossed.** The barrier orders work *the runtime delivered*. A component whose state changes from a raw timer, an event handler or a direct method call never went through the queue, and no barrier can detect it — there is a test that does exactly that and catches the component mid-handler, deliberately, to record that eligibility is a claim about a component's code rather than a property the runtime can verify.

**An obligations manifest may be empty and may not be absent.** A component that owes nothing owes nothing, and saying so is a finding. A missing manifest means nobody looked, and a successor told it had assumed everything when nothing was recorded is the failure this phase exists to prevent — so the envelope carries the manifest inside its hash, and `admissibleForHandoff` refuses a handoff snapshot without one.

**Silence is not a claim.** `planRestore` pairs the manifest against what the successor declares, and an obligation the successor says nothing about resolves to `unhonourable` — never `assumed`. A revision that has never heard of `mix-dwell` cannot be said to have preserved it. The five resolutions are different claims, not degrees of success: `assumed` (the same obligation, unchanged), `reestablished` (an equivalent one, and something observable differs), `completed`, `failed` (and whoever is owed the result is told), `unhonourable` (and the handoff does not happen). It refuses on the first thing nobody can honour rather than reporting a plan with a hole in it, because a partial plan reads as progress.

**A timer has no default policy, and asking for one is the bug.** Every policy is right for something and catastrophic for something else: a dwell that restarts has doubled a bake, a watchdog that preserved its deadline fires the instant the successor comes up. `preserve-remaining`, `preserve-deadline`, `restart`, `fire-on-activation` and `refuse-if-overdue` are each named at the timer by somebody who knew what that timer was for, and `restart` and `fire-on-activation` resolve as `reestablished` rather than `assumed` because something observable changed and the provenance has to say so.

The same rule reaches the rest. A lease is carried only where its issuer knows what a *logical* owner is — assuming otherwise hands the successor an authority the issuer does not believe it has. A re-established subscription has to say what the transport will do to it, because "recreated" without `exactly-once`, `at-least-once-deduplicated`, `at-least-once` or `gap-possible` is a claim of continuity the transport underneath has not made.

**And the plan is proved twice.** `validateAtBarrier` re-runs it against the snapshot actually taken at the barrier and compares it with the one proved while preparing. A component that took on work in between, or finished something, is owed a different set of things — and the moment before a cutover is the worst possible time to find that out.

Nine capture rules and eight restore rules, each checked against a build with the rule removed. What is still not here is the activation: running the successor beside the incumbent and cutting over under a fence is Phase 3, and a proved plan is permission to hand over rather than a handover.

### `@source-repo/signalr` publishes on a tag like everything else

It was the one package the release workflow did not publish, so 5.1.0 moved every other package and left this one at 5.0.0 - published by hand once and then not. That is precisely the drift the versions-together rule exists to prevent, and it went unnoticed because nothing failed: a package that is simply absent from a job does not report anything.

Same step and same guard as the others, so it rides every tag and a release that did not touch it publishes nothing.

### Live values beside the source that declares them

The oldest way of looking at a machine — the program on screen with what each thing currently is written next to it — and it needs no debugger, no instrumentation and no second data path.

**That last part is the whole economy of it.** Props and state are already observable: a subscriber receives them, `authorize()` has already ruled on them, a projection has already narrowed them. So the only thing missing was *where each one is declared*, which is static, known at build time, and costs the running artifact nothing. Which makes the design's third acceptance criterion — that a user cannot obtain a field through source view that they could not obtain through ordinary authorised observation — a fact about the architecture rather than a check somebody has to remember to write.

**`source-rpc extract --bindings <file>`** records it, from the same resolved types the contract came from, so the paths a viewer overlays and the paths the contract publishes cannot be two different answers. It descends through objects and stops at records and arrays: a record's keys are data, so `tags` has a declaration and `tags['tag.007']` does not, and inventing a span for it would put a value beside a line that says nothing about it.

**`@source-repo/diagnostics`** serves it, and it is a *component* — because the design says so in the shape of its own contract. The illustrative `NodeDiagnostics` has `capabilities` and `activeSource` as readonly properties, and a readonly property a viewer watches is what an observable component already is here. So a redeploy that changes the running revision reaches every open editor without anybody polling. `source()` is a separate method because it is a separate permission: a viewer may be allowed to know that `state.setpoint` is declared at line 34 and not be allowed to read the file that says so. A node given no source root serves bindings and no text, and advertises `sourceAvailable: false` rather than failing when asked.

**Nothing is drawn on the wrong source.** A value positioned by a line number from a file that has since been edited is worse than no value: it is a number somebody will act on, sitting beside a declaration that is no longer the one it came from. The revision and the file hash are compared before anything is overlaid, and the refusal is a **sentence** rather than a boolean, because three different problems live there — the file has been edited, the node has been redeployed, the file was never part of this build — and a viewer that answered "false" to all three would leave a person guessing.

Every later phase's capability is advertised and `false` rather than omitted: a viewer that finds `exactPause` absent cannot tell *this node cannot* from *this protocol version had not thought of it*.

The console has it behind a `source` button on a component panel, asked for rather than fetched when the panel opens — reading a peer's source is its own disclosure, and a panel that took it whenever somebody looked at a setpoint would be taking it on their behalf. Verified against a real peer serving the repository's own example: fifteen live values on the real `plant.ts`, and then, after a line was added to the file on the node, zero values, the listing dimmed, and the reason spelled out.

One property fell out that nobody designed: `Zone` is one interface used by both oven zones, so the line declaring `temperature` carries **both** zones' values at once. That is correct, and more informative than the design anticipated.

### A component's state can outlive the process that held it

The first phase of the online-change design: a component is a logical thing with a persistent address, and the process implementing it is not. **`@source-repo/continuity`** is what it keeps across that boundary — versioned snapshots of held state, adjacent forward migrations, and a record of every value that moved.

**Phase 1 makes no claim of live process replacement, and says so in code rather than in a note.** `admissibleForHandoff` returns a *reason* rather than `false`, because the obligations a running activation holds — the timers it owes, the calls it has out, the leases it is answering for — are not captured yet, and "we have snapshots" must not be readable as "we can hand over".

**Held state has to be explicit, and the rule is enforced instead of documented.** State is `structuredClone`d before every migration step; state that cannot be cloned is refused, naming why. A closure in a state field is the shape of everything that cannot survive the process holding it, which is exactly what the design says state must never be. The clone is then frozen, so a transform that writes to its input fails rather than being obeyed.

**One reviewed transform per adjacent version**, walked in order. That is V−1 transforms to maintain rather than one per version pair — and, more to the point, one place per version where somebody had to decide what a new field means. A direct K→N transform is a decision nobody reviewed, taken about versions that were never adjacent. Two steps registered for one pair are refused: which ran would otherwise depend on module load order.

**Three outcomes, and they are not degrees of success.** `total` says the old state determined the new one. `defaulted` says a value came from a decision, and records the field, the value, the approver and *why* — because six months later the question is never whether a default was applied, it is who chose it and against what. `impossible` refuses the chain, naming the field, rather than inventing a value nothing downstream could tell from a measured one.

**There is no separate dry-run path, and that is the point.** A dry run executing different code proves nothing about the committed one, so migration is a pure function of an immutable snapshot and a dry run is calling it and not storing the answer. Two calls over one input produce the same snapshot in every field, hash included, because a derived snapshot carries its parent's `capturedAt` — deriving is not observing, and that is what keeps a clock out of the answer.

**Determinism is checked rather than assumed.** Every step runs twice and its two outputs are compared, which catches a clock or a random value — the two that actually happen. There is deliberately no way to switch it off, because an off switch is what gets flipped when the check fires.

Golden snapshots are retained as files under `golden/`, one per released state version, read verbatim: a fixture the code constructs agrees with whatever the code now does, which is the one thing a regression test must not do. Six rules were checked against builds with the rule removed.

One thing moved in the library for it: `digestText` and `canonicalDigest` are exported from `Canonical.ts`, and the row stamp now uses the first. A snapshot hash and a row stamp had the same five lines twice, and neither is a place to discover that two implementations rounded a detail differently. The stamp's pinned fixtures are unchanged, which is what says the extraction moved nothing.

## 5.1.0

**Read this first if you hold a row stamp.** `RPC_STAMP_VERSION` moved from `sw1` to `sw2`, so every stamp minted before this release compares unequal to the row it was taken from. A caller holding one is told its row changed, re-reads and is right — which is the direction the version exists to guarantee — but it happens on the first write after the upgrade rather than at a moment anybody chose. The encoding change behind it is in the entry below.

The .NET packages move to 5.1.0 with these, and **`SourceRpc.Query` and `@source-repo/query` are new at 0.1.0**, on their own version lines for the reason `@source-repo/queue` has one.


### The pull half: a page can be *confirmed current*, and a period can cost nothing

A pulled page needed a period, and a period asked every five seconds whatever the plant was doing — so a page nobody had changed cost exactly as much as one that changed twice. What settles it was already on the wire: every `$data` answer names the epoch and revision it was drawn from, and a component channel holds the epoch and revision the publisher is at. A page whose revision matches the channel's has had nothing published over it since it was drawn.

**`@source-repo/query`** is that comparison wired into `@tanstack/query-core`. Its own package on its own version line, built against the library's public API only — the `@source-repo/queue` precedent, and for the same reason. Not in `@source-repo/rpc`, which would put a query cache in the bundle of every peer that never pulls.

The line between the two libraries is worth stating, because it is the same line in both languages. **Theirs**: dedup, storage, eviction, backoff, stale-while-revalidate, persistence, devtools — none of it interesting, all of it fiddly, and rebuilding it would be rebuilding it twice. **Ours, and unobtainable from any cache library**: that a page drawn at the revision the channel holds is confirmed current; that `semantics` decides whether a retry is safe at all; that a deadline is a budget the caller declared rather than a per-attempt timeout; and the key that makes two questions the same question.

**Three states, never two.** `current` is a fact from the source. `possibly-changed` says the publisher has spoken since, and whether it touched *this* is a further question. `unknown` is first-class, because the signal is silently absent wherever no channel is open — which a console does routinely, since a component whose state is only a record has no typed leaves and opens no subscription at all. Collapsing that into `possibly-changed` would look like caution and would be the same fake one level down: a screen saying *this may have changed* where what is true is *nobody here knows*. A `current` that is sometimes a guess is worth nothing.

**A period tick over a `current` page asks for nothing at all**, which is the whole difference from the loop it replaces. `refetchInterval` is deliberately not turned on: the period belongs to whoever is watching, which is the entire reason `$data` is a call rather than a subscription.

**Declared resources are excluded structurally rather than by a note**, and the reason is concrete: Relational, Document and Queue bump their revision on **reads** and on a metrics timer, so wiring the rule to their resources would make every answer invalidate itself — a poll with no period, against the peers least able to afford one. A new epoch is the exception and drops them too, because a component that came back may have reconnected to a different database.

**A late answer carrying a lower revision is not published as fresh.** Two requests for one key and the second answered first is ordinary on a network where a peer may be reached over MQTT; without the rule the older page lands last and is reported current on a comparison that was never really made.

**A settled call invalidates what it claims to have touched, and nothing else** — `sets` for an editor, the resource for an action offered on a row. With neither it invalidates *nothing*, and that degradation is the point rather than a gap: `sets` declares intent, is optional, and carries no compatibility rule, so a method that says nothing must cost nothing. What still covers that case is the revision compare, which is a fact from the publisher rather than a claim from the caller.

**Two cache defaults are wrong here and are replaced.** Queries are retried three times by default, which is right only because a `query` is a query — and `semantics` is optional in this library on purpose, so absent reads as *does not say* and nothing is retried. And a retry will happily re-issue a call whose deadline has passed; a deadline here is a budget, so every attempt is given what remains and one that arrives with none left is refused rather than sent. `Forbidden`, `Superseded`, `OwnershipChanged` and the rest are refusals rather than failures, and asking again only gets them again.

**`onlineManager` can be wired to the link**, so "offline" means this link rather than `navigator.onLine` — which is true on a plant LAN with no route to the peer, and false on a laptop whose Wi-Fi dropped while the plant is reachable over Ethernet. The same source in Node and in a browser.

Every rule above has a regression test that was checked against a build with the rule removed.

### What this peer asked for, kept after the promise has gone

A client already knows what it asked and how each of those turned out - it mints the id, holds the promise, arms the timer and classifies the failure. Then the promise settles and it forgets, which is fine for a program because a program *has* the promise. It is not fine for a person: what an operator needs after pressing a button on a plant is not the return value, it is whether the command ran - and if nobody knows, that nobody knows.

**`client.operations`**, and `server.operations` beside it, keeps one frozen entry per call in the shape the component store already defines, so a screen binds to it with `useSyncExternalStore` and nothing new has to be learned. **No wire change and no contract change**: it is hooked at `callWith`, which is already the single funnel a client's calls, a server-acting-as-caller's and a component channel's all go through, so one hook covers every one of them and there is no second implementation anywhere.

Six statuses, and two of the distinctions are the library's own rather than a cache's. `issued` and `sent` are separate because a request the transport never accepted certainly did not run and one it did may have. And **`unknown-outcome` is a status rather than an error string**, because it is the row a tray must not let scroll away: `UnknownOutcome` and `Timeout` both land there with the code kept beside them, since the two are the same fact about a plant reached by different routes. `mayHaveRun` is exported so a screen classifies a failure exactly as the registry does - one disagreeing with the tray beside it would be disagreeing in front of an operator about the only question that mattered. `deferred` is the sixth: a method that answers twice has a call that succeeded and an operation that has not.

**Arguments and results are not retained, and that is a security property rather than a preference.** An `untap(token)` argument is a bearer capability and a `$data` answer is a page of plant rows; a peer-wide store holding either would hand every screen in the process a read surface `authorize()` was protecting on the way in. What is kept is a description of the request.

The bound has three tiers, each a claim about who still has business with the row. Settled-and-certain goes first; then the oldest `unknown-outcome`, because bounded is bounded but that row outlives every settled call above it rather than scrolling off in front of them. **A call still in flight is never dropped**, so the registry may exceed `keep` - evicting one would take a command off an operator's screen while it was still happening and leave nowhere to record the uncertain outcome it may be about to become. It costs nothing: the client is already holding a promise for each, so this is bounded by concurrency rather than by uptime.

`$with({ semantics })` rides along and travels nowhere. A client holds no schema and this repository's rule is that a running class beats the schema for that question, so it decides nothing - what it buys is a tray that can say *this uncertain one was a non-repeatable command* instead of showing six identical rows.

### .NET could not read four of the error codes it was being sent

A code arrives as a string and is parsed by name, and the C# enum spelled nine of the fourteen the library defines. An unknown name falls back to `Exception`, which says *the method ran and threw* — so a TypeScript peer answering **`NotInControl`**, **`Busy`** or **`Superseded`**, every one of which certainly did *not* run, was telling a .NET caller the opposite of what it meant. **`UnknownOutcome`** — the one code that means *nobody knows whether it ran* — arrived as a definite failure, and `IncompatibleVersion` with it. All five are now spelled, and the .NET suite asserts the whole vocabulary against the list in `Messages.ts`.

`RpcOutcomes` puts the classification in the core rather than in a resilience package, because a caller writing a bare `catch` needs the same answer a pipeline does: `MayHaveRun`, `CertainlyDidNotRun`, `IsTerminalRefusal`, `MayRetry`. `CertainlyDidNotRun` is deliberately **not** the negation of `MayHaveRun` — an unclassified exception is neither, and reading *not known to have run* as *known not to have run* is exactly how a second pump start happens. A send the transport refuses is now classified `TransportError` rather than left as whatever the carrier threw, for the same reason: an unclassified failure reads as *unknown*, which is the safe reading and the wrong one.

Three fields the frame has always carried and no .NET caller could set arrive together as **`RpcCallOptions`**: the idempotency key, a per-call deadline, and the owner fence. The first two are what make a *retry* safe rather than a second command, so a resilience policy built without them would have been a policy for doing a thing twice.

### The pull half for .NET: `SourceRpc.Query`

Beside `SourceRpc` rather than in it, for the reason `@source-repo/query` is beside `@source-repo/rpc`: the core depends on nothing but the BCL, and a device binding that never pulls should not carry a resilience engine and a cache to reach a network it only answers. Its own version line at `0.1.0`, over **Polly** and **FusionCache** — two libraries rather than one because Polly deliberately has no cache, the v7 policy having been removed in favour of deferring to caching libraries.

**A deadline is a budget across every attempt**, which is the piece a policy library will not give you: every resilience engine offers a timeout per attempt and almost none offers what remains. `RpcCallBudget` hands each attempt what is left, and it travels as the ttl so the far end can refuse work that is already too late. A budget with nothing left refuses locally rather than sending a zero, because zero means *no deadline* on this wire — the same inversion the TypeScript side has a comment about.

**`ShouldHandle` reads the error vocabulary rather than the exception type.** A `TransportError` is retried even for a non-repeatable command, because it never left and so has had no effect to repeat; an `UnknownOutcome` is retried for nothing the caller did not declare repeatable. Undeclared means undeclared.

`RpcCanonical` is a **port** of the TypeScript encoder rather than an equivalent of it, and the tests say so mechanically: every expected string was produced by the TypeScript implementation, and the first is a substring of the literal `DataWrites.test.ts` pins for the row stamp — so changing either encoder fails one of the two suites. The two places .NET would otherwise diverge are written down rather than discovered: its JSON writer escapes `<`, `>`, `&` and everything non-ASCII, which is valid JSON and a different string, and it writes an integral double with a decimal point where JavaScript does not.

Two of FusionCache's features are worth naming because this repository arrived at them independently before adopting them, which is the strongest reason to take a dependency rather than the weakest: **fail-safe** is the console polling loop's rule that a failure annotates the previous answer rather than clearing it, and a **soft timeout** is answer-stale-while-refreshing.

What is deliberately absent is freshness from the publisher. *Confirmed current* needs a component channel, and a .NET peer cannot observe a component at all — so this is an age window, labelled as one, until that changes.

`SourceRpc.Tests` is the first .NET test project here, and CI now runs it. What it covers is exactly the rules the two languages must agree on; everything else in this package is still interop, which proves the two speak and cannot reach a pure function.

### The console has an operations tray

Every other tab in the console's right-hand column is about the network. This one is about the page: what it asked other peers to do, and how each turned out. The count on the tab is not a count of things to read but of commands nobody knows the outcome of, so it stays until each is dealt with rather than clearing when the tab is opened.

**A relayed command is recorded as the command it is about, not as the relay**, and that needed something the registry could not get from `callWith`. The method panel's calls are made by the console *process*, and the console reports the plant's answer as a **value** rather than by failing - so the page's own entry for `console.call` says `succeeded`, correctly, while the command it carried may have been left in the air. A tray built only on what `callWith` saw would show the one outcome an operator must never be shown wrongly. `RpcOperations.relayed` is the door for that case, and the entry carries `via`, because the relay not answering and the relay answering *with* an uncertain outcome are different facts.

Three views: `uncertain` by default, `commands` - which is `semantics !== 'query'`, keeping the undeclared ones, because a method that says nothing must be treated as a command - and everything. `clear settled` takes only what is over and certain; an uncertain row is dismissed one at a time and on purpose.

Verified end to end against a fake peer that never answers: two presses of *try again* produce two rows carrying **one** idempotency key, which is the whole claim - two attempts at one command rather than two commands.

### The console attaches an idempotency key to every press, and offers a safe retry

The CLI attached one and the console did not, which is the wrong way round: the CLI is driven by somebody typing a command they can read back, and the console is the thing an operator actually presses. Without a key a second press after `UnknownOutcome` is a second command, which on a plant is the difference between one pump start and two.

**A key per press, held for the retry, gone the moment anything else is committed.** A key generated per *attempt* buys nothing - that is what the request id already is - and one derived from the value would be worse, since committing 180, then 190, then 180 again is three decisions and the third would be answered with the first one's record.

The offer to try again appears **only where nobody knows what happened**, drawn as its own line rather than folded into the error text beside it: a refusal is a fact about the plant and this is the absence of one, and the two need different words and different buttons or an operator learns to treat both as noise. It covers all three ways the console commands a plant - an editor drawn from `sets`, an action offered on a row, and the method panel's Call. The last is relayed, so `console.call` gained a trailing optional `idempotencyKey`: the call to the plant is made by the console process rather than by the browser, and a key minted in a page reaches the wire only if that verb carries it. The **repeat** button deliberately carries none and offers no retry - it says twenty calls and means twenty, and there is no single intent for a second attempt to be at.

**Command parking is still not built, and the decision is now recorded rather than pending.** The harm case that survives every proposed gate is the grant boundary: an HMI holds the oven's lease and decides `setMode('manual')`, the link drops, the lease expires, the link returns, the application re-acquires - and the parked command passes the authority check cleanly, because that check asks *does this source hold it now* and never *is this the same grant the operator decided under*. The fence that would catch it is not on the wire. Anything wanting a command to outlive its caller wants `@source-repo/queue`.

### A store-backed node can name the state of a whole resource

The pull cache's freshness comes from the component's revision, and that deliberately says nothing about a **declared resource** — a table, a document collection, a queue — because those live behind the component and the shipped store-backed nodes move their revision on *reads*. `RpcResourceStamps` is the beginning of an answer for them: one registry shared between a node's read half and its write half, the writer claims what it may write, and every write that lands moves that resource's stamp. `getList` and `getMany` carry it as an optional `stamp`.

**Read it exactly.** Two answers carrying the same stamp describe the same state of that resource *as far as writes this node served are concerned* — so a match means **nothing I did changed it**, never *nothing changed it*. A table moved by another service, a scheduled job or a person at a SQL prompt goes past unseen. It is not ordered either: two stamps are equal or they are not, and neither is newer.

**A stamp exists only for a resource a writer claimed**, and that is structural rather than conventional. A deployment that hands the registry to its read service and forgets the write service gets no stamps at all rather than a set that never moves — which is the failure that matters, since a node publishing a stamp that stays put while its database moves is worse than one publishing none. A refused write moves nothing: a conflict is a change that did not happen, and telling every reader to discard its pages over one is how a precondition becomes a traffic source.

`packages/conformance` asks both halves of it — does a write move the stamp, does a read leave it alone — of SQLite, Postgres, MySQL and Mongo alike, and both halves were checked against builds that get them wrong. The use it already has is `sameResourceState(a, b)` in `@source-repo/query`: the question offset paging cannot otherwise ask, since a row inserted between page one and page two renumbers everything below it. Three-valued, with `undefined` for *this node does not speak for that resource* — reading an absent stamp as "unchanged" is the one way a pager can be told the set held still when nobody said so.

`RPC_STAMP_VERSION` is unrelated and unchanged by this: a row stamp is a precondition over one row, and a resource stamp is a name for the state of a collection.

### A concurrent `refresh()` could install an older catalogue than the one already in place

`refresh()` on the relational and document nodes is an `@rpc` method on a `parallel` service, so two callers can be inside it at once — and `this.catalogue = await readCatalogue(...)` is last-**finished** wins rather than last-started. A read that began before a migration can land after one that began *after* it, installing a catalogue missing exactly the table somebody refreshed to see, on all four services.

Found because it is what made `packages/document`'s own suite flake: three concurrent tests each add a collection, refresh, and drop it, and one of them would find the collection it had just added absent. Catalogue reads are now serialised per service, so the last one *started* is the last one installed, and one failed read does not poison the refreshes behind it.

There is no dedicated regression test for it, and that is worth stating rather than glossing: forcing the interleaving needs a catalogue read that is slow on demand, and a test that cannot make the race happen would assert nothing while looking as though it did. The evidence is that the flake reproduced on every run before the change and on none of four after it.

One genuine test-isolation bug surfaced with it and is fixed: two concurrent tests in `Exposure.test.ts` shared one database, where one added a collection and the other asserted exactly which collections the node served. A race with no fixed answer — whichever ran second was right about a different database than the one it was looking at.

### One encoder decides whether two values are the same value

Three things had to answer that question and there were three answers, two of them `JSON.stringify` — which reports **key insertion order**, which nothing promises. A JSON column round-trips through a driver, a document store hands back BSON, and a caller builds an options object in whatever order its code reads; each of the three then failed differently and quietly. The row stamp reported a conflict on a row nobody touched. The projection comparison re-subscribed, spending a targeted snapshot to receive what it already had. And a cache key would miss, asking the plant again for a page it is holding.

`canonicalValue` and `canonicalText` are now exported, and the row stamp, both `sameProjection` implementations and `@source-repo/query`'s key all run on them. The stamp's pinned fixtures in `DataWrites.test.ts` are what gate all three, because neither of the other two can pin itself — two projections compare *through* the encoder and two keys are *built* by it, so a change leaves both self-consistent and both wrong.

**One rule moved with it, and `RPC_STAMP_VERSION` moves to `sw2` because of it**: a key whose value is `undefined` is omitted rather than digested as null. `{ offset: undefined }` and `{}` describe the same subscription and the same question, and for the stamp it is the same argument key sorting already makes — a driver that round-trips a JSON column through JSON drops the key, one that hands back a live object keeps it as `undefined`, and digesting those differently reports a conflict on a row nobody touched. A caller holding an `sw1` stamp across the upgrade is told its row changed, re-reads and is right, which is the direction the version exists to guarantee.

### The console pulls through the cache, and `usePolled` is gone

One cache for the page rather than one per pane, so two panels on the same peer ask one question between them and a collection reopened a moment later is answered without a round trip. The channel a panel already opened is handed to the cache as the freshness signal — it opens nothing itself.

Each collection now says which of the three states it is in instead of only its age, and `current` is the only one drawn in colour: *may have changed* is ordinary and constant on a moving plant, and drawing it as a warning is how an operator learns to stop reading a pane.

The `settled` counter is gone with it. It made **every** collection in the pane a different question after any successful call — one round trip per collection, on the link least able to spare it, for a command that touched one row. What replaces it invalidates the resource an action belongs to, or the path an editor's method claims, and nothing else.

`polled.ts` is now `timing.ts` and holds the two things that genuinely are React: a number that has to tick to look alive, and a value that has to stop moving before it is worth acting on. Deciding when to ask was never that file's to make.

One thing found on the way: the console's typecheck was resolving `@source-repo/rpc` to the **Node** entry point while vite bundled the browser one, so anything exported from only the web build typechecked as missing and anything Node-only typechecked as present. `web/tsconfig.json` now resolves the `browser` condition, and the app's own tests — which really do run under Node — moved to `web/tsconfig.test.json`.

### A reload comes back with what was last known, and says how old it is

A dropped link keeps its values and puts an age on them, because last-known-with-an-age beats a blank. A reload threw them away and came back `initializing` — the one place that rule was not honoured, and on a link where the first snapshot is eighty seconds off it is eighty seconds of blank screen in front of an operator.

`components.persistence` writes each accepted snapshot where a reload can find it, and **`client.lastKnown()`** reads it back. That is a separate call rather than a mode on `component()`, deliberately: `component()` still resolves only on an accepted snapshot, so nothing here can hand a caller a stale view where it asked for a live one. What comes back is a plain view and no proxy at all — nothing on it can be called, and nothing about it can be mistaken for current. Its status is always `stale`, `receivedAt` is the age the values actually had, and `staleSince` is when the record was written rather than when the page started, because *stale since I reloaded* would understate it by however long the machine was off.

Three refusals, and skipping any one of them would draw last-known as current with nothing on screen to say so: nothing kept, older than the deployment's `maxAgeMs`, or written in the future — a clock that ran backwards is not evidence about a plant. A record refused for age is removed on the way past rather than refused again on every reload. The projection is part of the key, not just the record, so a page that comes back asking for different paths is never handed something claiming a shape it does not have.

**`scope` has no default, and that is the security of the feature.** With `localStorage` — the right choice for a kiosk or a panel that must survive a power cut — plant values sit at rest, unencrypted, for whatever opens that origin next, so the scope is what keeps one operator's screen from being drawn for another. It is deliberately not derived from this peer's own name: a console page's name is random and lives in `sessionStorage`, so keying on it would orphan every record at exactly the browser restart `localStorage` was chosen for. `localStorageSnapshots()` is the browser adapter, exported from the web build; the store is an interface, so a deployment wanting fidelity for `Date` or binary supplies IndexedDB and structured clone instead of JSON.

**`authority` is never written.** A lease carries an expiry stamped on a server's clock, and the plant may have been handed to another panel while this page was not running. Values keep; arbitration does not.

### A channel can stop listening while nobody is looking, and hold on briefly after they leave

Two options on `components`, both off by default, both built on one new primitive: a channel that drops its remote subscription and keeps everything else — the values, the listeners, the epoch.

**`activity`** stops the subscriptions while this peer is inactive and restarts them when it is not. A console left on a spare monitor over a weekend otherwise receives every snapshot of every component it ever opened. The signal is injected rather than read from the DOM: the component client is exported from the Node build as well as the web one, so it must not touch `document` at all — and injecting it is also what makes the behaviour testable under a Node test runner, and what lets a kiosk, a screensaver or an application that knows its own pane is closed supply something better than the document can. `visibilityActivity()` is the browser implementation and is exported from the web entry point only.

Off by default, and the reason is sharper than the wall panel usually cited: a page hosting the Sparkplug projection runner turns a non-live status into a device **DEATH**, so an edge node would go offline because somebody switched tabs. The grace period is in seconds for a related reason — every resume costs a full targeted snapshot, so an operator alt-tabbing to check something would otherwise pay one per switch on exactly the link this protects. Resuming is immediate. A paused view goes **stale** and never stays `live`, because nothing is arriving and the freshness is genuinely unknown; a resume that fails is retried with a bounded backoff, since a resume that failed silently would leave a pane somebody is looking at stale for ever.

**`keepAliveMs`** holds a channel for a while after its last observer leaves, so a pane closed and reopened inside the window costs nothing on the wire and is still `live` — the subscription never went, so there is nothing to restore. It deliberately stops there rather than going on to hold a cold cache: `component()` still resolves only on an accepted snapshot, and that promise is worth more than a cache nobody could read without weakening it. What this buys is the round trip, not a stale read. The cost, stated because it is otherwise invisible: inside the window the channel is still live, so a store handle whose owner has already called `close()` goes on being notified until the window ends.

Both regression tests fail with the feature removed.

### A snapshot keeps the identities it can, and a store can be narrowed to one thing

Every accepted frame was installed exactly as it was decoded, so every object in it was new on every publish — and a consumer selecting anything larger than a primitive re-rendered whether or not what it selected had moved. One tag at 10 Hz redrew every pane bound to any object in that component. The console had already worked around it twice, selecting only primitives and joining a record's keys into a string to get something comparable, and those workarounds are the evidence rather than the fix.

An accepted frame is now reproduced against the one before it, keeping the previous reference at every node whose value did not move. **This is not a merge**, and the distinction is the whole design: the result is always deep-equal to the frame that arrived, and nothing is ever carried over from an earlier one. A merge in the ordinary sense fills gaps in the new frame from the old, which this repository already calls inventing — and it is reachable, because a channel's own feed can be re-projected underneath it by one ordinary `on($snapshot, handler, paths)`. Reproducing the frame means a narrowed subscription narrows the view, with no guard needed to make that true. Identities are shared within one epoch only: an epoch is the statement that this is a different object under the same name, and telling a memoizing reader that nothing changed across that boundary would collapse two different facts.

Plain objects and arrays are walked; typed arrays, `Map`, `Set` and anything with a prototype of its own are compared by reference, so a component carrying binary in its state gets no sharing on the path from that buffer to the root — msgpack round-trips a `Uint8Array` as itself, and walking a waveform on every publish would cost more than the sharing saves. `Date` compares by its time.

On top of it, `RpcComponentStore` gains **`select`** and **`at`**. `select` takes the whole view, so the revision and the status stay selectable; `at` takes a path spelled exactly as a projection entry is. Both are `getSnapshot`/`subscribe` stores that `useSyncExternalStore` consumes unchanged, both cache — a selector returning a fresh object per `getSnapshot` is React's cached-snapshot loop, which is most of the argument for this being in the library — and both attach to the channel only while something is listening.

`at` carries the **status** beside the value deliberately. A pane selecting `state.pressure` alone would go on drawing the last number after the feed went stale and never re-render to say so, which is this channel's central claim defeated by an optimisation. It just as deliberately omits `receivedAt` and `confirmedAt`: those move on every frame, so carrying them would notify every selected leaf on every publish — the exact re-render the selector exists to avoid. They belong to the one line that draws them, and the age of an individual reading belongs in the reading, as `RpcSourcedValue.at`.

The two ship together because neither is worth much alone: a selector over an object can only bail out if the object kept its identity, and sharing with nothing selecting is forty lines the console no longer needs. Both regression tests fail when either half is removed. `select` and `at` are required members of a published interface, so anything outside this workspace implementing `RpcComponentStore` by hand will need them — nothing in the workspace does.

### `status` is about the link, and freshness of a reading is about the reading

The channel's status has always been a fact about the **link** — snapshots are arriving — and it has always been read as a fact about the **values**. Those part company more often than the guide admitted: a component that stops polling its devices publishes `live` for ever, because nothing here watches a publishing cadence, so a gateway fronting fifty devices with three of them unreachable reports `live`, a rising revision, and twenty numbers of which three are from 14:03. `receivedAt` does not close it either — it is local receipt time, the age of the last hop rather than of the measurement.

The guide now says so outright, in the section that previously claimed the status tells the truth and left it there.

What it does **not** do is add a freshness section beside `props` and `state`. That was the obvious design and it does not survive contact with the case it exists for: the three-hundred-tag component is drawn through `$data`, whose result type has no such field and whose filter grammar reaches inside a row only — so the operator question, *which three of three hundred are quiet*, would still be unaskable. Narrowing such a section under a projection produces a false all-clear, not narrowing it claims knowledge of paths the frame does not carry, and since a snapshot travels whole, each freshness transition costs a full publish — measured at 13.7 kB on 300 tags, about ninety seconds at 1200 baud.

So freshness is data about a reading, and it goes where this library already puts data: **inside `props` or `state`**, where the schema describes it, `extract` publishes it, the compatibility checker rules on it, a projection narrows it for free, and `$data` can filter, sort and page on it. `RpcSourcedValue<T>` — `{ value, at, quality?, unit?, forced? }` — is now exported as a named type. It is a convention rather than a mechanism, and naming it is admitting what three things already assume: `@source-repo/sparkplug` constrains `qualityPath` to a path inside props or state, the console recognises this shape and draws it as one row, and `quality:bad` is typeable in a filter today. Nothing enforces the spelling, and the guide says that too.

The console now accepts `at` as a qualifying sibling, so `{ value, at }` — the minimum form — is drawn as one row rather than expanding into a branch of two, and it draws the stamp as a **clock time rather than an age**. An age is only true at the moment it renders, and a row for a value that has stopped changing stops re-rendering, so "3 s ago" would sit there being wrong; a time is true whenever it is read.

For the case where a whole source went quiet rather than a value — fifty tags behind one gateway — the guide documents publishing the source as ordinary state beside them, with `DockerService` as the worked example it already is.

### The compatibility checker can see the component section it was checking

`namespaceProblems` compared `component.props` and `component.state` and nothing else, so a component could change the version of its snapshot envelope and `check`, `check --peer` and `conform` would all report no breaking changes. A false "safe" is the expensive direction, which is the argument that file is written around.

It now compares `component.snapshot`, in both directions — the number exists to say the layout *around* props and state is different, and an observer parses the layout it was built against whichever side moved. This has to be in place before any future change to that envelope, which is the other reason it is here now rather than then.

### A frame is never handed to a transport that cannot send it — and this is why the next release is a major

The library's headline claim about machinery is that a call which timed out will not run afterwards. It was not true, on two of the three transports, and the demonstration is short: with the link down, a `non-repeatable-command` was issued, its caller was told `Timeout: no response to pump.start within 2000 ms`, and the method then **executed 11.8 seconds after the call was made — 9.8 seconds after its caller had been told it had failed**.

Nothing was broken in this library's own logic. socket.io buffers an emit made while disconnected and flushes the buffer on reconnect; mqtt.js stores the packet and replays it verbatim, including the message expiry it was given, whose clock only starts when the broker finally receives it. The server's deadline re-read cannot see any of it, because that budget is measured from the moment a frame **arrives**, and these arrive untouched. SignalR has always refused to send while disconnected — so the same program got three different answers to the most safety-relevant question this library claims to have an opinion on, and the regression test that was supposed to cover it only ever exercised the in-process wait.

Both client transports now refuse instead, alongside the check for a missing socket or client that was already there for the same reason. The call fails at once with `TransportError`, which is the code that means *certainly did not run*, and it now goes on meaning that.

**This is a behaviour change, and it is the one that makes this release a major.** A call that used to survive a two-second blip by being quietly buffered will now fail. That is the point — a buffered command is a command nobody is waiting for any more — but an application that was relying on it will see failures it did not see before, and the honest place to say so is the version number rather than a paragraph. It narrows a race rather than closing it: the link can drop in the moment between the check and the emit, and what protects a command there is the same thing that always did, which is `UnknownOutcome` and an idempotency key.

`sentRequests`' promise is worth restating now that it holds: it is not proof of delivery, and nothing here can have that — it is proof that the frame left, which is the line between a command that certainly did not run and one that might have. On socket.io that was proof of nothing.

### A subscription is restored when the peer comes back, not only when the link does

`resubscribe()` was wired to the transport's `connected` event and to nothing else, which covers exactly one of the two ways a subscription is lost. Behind a bus — the topology this library exists for — the observed peer restarts and the observer's link is never touched: no `disconnected`, no `connected`, nothing replayed, and the revived peer holding none of the subscriptions it had a moment ago. The channel went `stale` on `peerGone` and stayed there for ever, showing a pre-restart value, while `peerOnline` went past with nothing keyed to it. Reproduced on socket.io and on MQTT, gracefully and by kill; a bare `resubscribe()` was the whole repair in every case.

So `peerGone` and `peerDisplaced` now **mark** that peer's subscriptions, and `peerOnline` replays the marked ones. Marked rather than all of them, because every replay is answered with a full targeted snapshot: MQTT emits `peerOnline` for every retained presence message rather than on a transition, so this peer's own reconnect re-announces every peer it has ever seen, and replaying blindly would send a second snapshot per component down the link least able to carry one. A link-wide replay and a peer's return no longer double up either — whichever is already running covers it.

`RpcClientHandler.resubscribe()` therefore takes an optional peer, and `markLost(peer)` is public beside it. `RpcServer` does the same for the subscriptions it holds as a caller, and forwards `peerOnline` to the context resolver, whose chains gain `peerReturned` — a hop whose peer restarted is repaired by re-opening that hop and by nothing else, and its subscriptions are method-registered so the event replay could never have reached them.

### A replay that fails is retried, unless the refusal was a decision

`resubscribeFailed` named the subscriptions a pass could not restore and then stopped, so a peer that was still booting when the replay went out stayed unsubscribed until something else happened to trigger another one. The failures now start a bounded backoff — eight attempts over roughly two minutes, half-jittered so a hundred observers of one peer do not all ask again in the same millisecond — and a replay from any fresh trigger supersedes whatever a chain was in the middle of.

**Two refusals are terminal and are not retried: `Forbidden`/`Unauthorized`, and `ClassNotFound`.** The first is `authorize()` having ruled, so retrying is a peer repeatedly asking for what it has been told it may not have, with every attempt landing in somebody's audit log. The second is a peer that no longer serves the namespace, which is a decision about what it is rather than a moment it is having. Everything else — a peer not yet up, a broker that would not take the publish, a full mailbox — is timing, and timing is what a retry is for. Terminal *in kind*, not in severity.

Giving up is now said out loud, on a new **`resubscribeAbandoned`** carrying the same shape as `resubscribeFailed`. `stale` means the freshness is unknown; this means nobody is working on it any more, and a channel that reported only the first would leave an operator waiting for a repair that is not coming. Abandonment is never permanent: any fresh trigger — a link back, a peer back — clears it, because a restarted peer is a new incarnation and the refusal may have gone with the process that made it. `resubscribeRetry` on the client handler carries the numbers.

One case is still open, and it is **not** the one a retry covers. Where a hub coalesces a peer's departure and return so that neither `peerGone` nor `peerOnline` fires, nothing marks the subscription lost and nothing attempts a replay — so there is no failure for a retry to work from, and the channel goes on reporting `live` while holding a value from a process that no longer exists. That is the absence of any publish-cadence liveness rather than a gap in recovery, and it wants its own answer.

### A refused subscribe no longer leaves one behind

Both halves of a subscription — the map entry that reconnects replay from, and the local emitter handler — were registered before the `on` call was issued, and neither was unwound when it was refused. The ordering is right and has to stay: the server attaches its listener before answering with a snapshot, so a handler registered after the reply could miss an update that landed in between. What was missing was the rollback, so a failed `component()` left a phantom that every later reconnect faithfully re-issued against a namespace that had already said no, with no channel behind it to receive anything. Dormant until now; a retry loop would have turned it into recurring traffic.

The entry is removed only when no local handler remains, which is the same reference count `off` reads and for the same reason: one observer's refused subscribe must not delete the entry another observer's live subscription is replayed from.

### A snapshot carrying no news still says the feed is current

A component channel discarded any frame that was not strictly newer than what it held. That is right about the values and it was wrong about the link, and the case where the two part company is the common one rather than an exotic one: a component that does not commit while the link is down is answered, on re-subscribe, with a targeted snapshot at exactly the revision the observer already has. The repair arrived, was dropped as stating nothing new, and the view went on reporting `stale` — behind a subscription that had just answered, and with nothing on it to distinguish that from a peer which had genuinely gone quiet. In a channel whose argument is that the status tells the truth, that was the status telling the reverse of it.

Such a frame now **confirms** rather than being discarded. The values, the revision and their object identities are untouched, so nothing a reader memoizes on moves; `status` returns to `live`, `staleSince` clears, and the receipt time splits in two.

`RpcComponentView` therefore gains **`confirmedAt`**, and `receivedAt` keeps the meaning it always had. `receivedAt` is when these values arrived; `confirmedAt` is when the feed last proved it is current. A reading taken at 14:03 whose feed answered a re-subscribe at 14:19 is both three quarters of an hour old and current, and the alternative — moving `receivedAt` on a confirmation — would have made a screen say a value had been updated when only the connection had. That is a small instance of exactly the conflation this channel exists to refuse, so it is two fields.

The console prints both where they differ (`rev 41 · updated 14:03, confirmed 14:19`) and one where they do not, and the MCP `read_state` tool reports both. `@source-repo/sparkplug` stamps its metrics from `receivedAt` and is left alone deliberately: a confirmation is not a new measurement, and a re-birth should not restamp a value that has not moved.
### The public surface of the C# packages cannot move by accident

The last item on the review's release list. Nothing failed a build when a public signature changed, so a breaking change reached a package as somebody else's compile error after they upgraded - and the first anyone knew of it was that.

Each packable project now carries a committed `PublicAPI.Shipped.txt`, and `Microsoft.CodeAnalysis.PublicApiAnalyzers` fails the build when the real surface differs from it. In either direction: `RS0016` for something public that is not written down, `RS0017` for something written down that is no longer public. The second matters as much as the first - a member quietly made `internal` is a breaking change that would otherwise leave no trace at all.

Both directions were checked by making the change and watching the build fail: adding a property produced RS0016 naming it, and demoting `MaxHops` to internal produced RS0017. The baseline is 535 entries across the four packages, generated from the analyzer's own diagnostics rather than written by hand.

`API-BASELINE.md` explains what to do when it fires, and the three cases are genuinely different: an API you meant to add is a line in `PublicAPI.Unshipped.txt`, an API you meant to change needs a major version, and an API you never meant to expose should be `internal` - which is what most of them are.

The analyzer is a build-time dependency and does not appear in the packages; verified by reading the nuspec rather than assuming `PrivateAssets` did its job.


### NuGet publishing is automated, and the C# tests now run in CI

A version tag already published the npm packages and the CLI image; the four .NET packages were still built by hand and pushed to a folder on one workstation. They now ride the same tag.

**The .NET version is deliberately not the tag.** It lives in `packages/csharp/Directory.Build.props` - one place rather than four csproj files, which is four places to edit and three chances to miss one - and moves when the C# packages actually change. A documentation fix to the TypeScript README should not publish four NuGet packages with nothing in them, so the job skips whatever is already on the registry, the same bargain the queue and docker packages already make.

**The packages are installed before they are pushed.** `smoke-test.sh` puts all four into a fresh project with an empty NuGet cache and compiles against them. Packing proves a file was produced; it does not prove anyone can use it - a missing dependency, an unconsumable target framework or a type left internal all pack perfectly and fail at whoever installs them first. A NuGet version cannot be replaced once pushed, so this is the last point at which that is still fixable.

Centralising the metadata broke two things that only inspecting the artifact would show, and both are worth recording because they failed silently:

- Every package packed as **1.0.0**. `Directory.Build.props` is imported *before* the project body, so a block conditioned on `IsPackable` - which the project sets - saw it unset and evaluated false. The packable metadata moved to `Directory.Build.targets`, which is imported after.
- Then every package shipped with **no XML documentation at all**, because `GenerateDocumentationFile` is read while compiling, long before `.targets`. Every doc comment in this repository would have been invisible to anyone consuming a package, and nothing failed. It is back in `.props`, where the compiler can see it.

Each package now carries its own README, so a NuGet page says what the package is rather than listing its dependencies.

**The C# unit tests now run in CI**, which they did not. CI built the test host and never ran the 43 tests - and several of the behaviours they cover cannot be reached from the TypeScript suite at all: a duplicate idempotency claim is a race inside one process, and the router's takeover race needs two threads interleaved at a single line. A green interop suite said nothing about either.

Both workflow commands were run locally exactly as CI will run them, and the already-published guard was checked against the live registry. The four package IDs are unclaimed on nuget.org; the job needs a `NUGET_API_KEY` secret scoped to them, and cannot publish without one.

Still not automated: public API compatibility. Nothing fails a build when a public signature changes, so a breaking change reaches a package as somebody's compile error - a baseline and `ApiCompat` in the release job is what would catch it.


### The rest of the review's pre-release list for the C# packages

The six correctness defects landed first. These are the items the same review named as wanted before .NET is a supported installation path rather than a preview one - less dramatic, and mostly about a peer being able to *ask* for what it can already enforce.

**A caller can request the semantics, not only obey them.** `RpcCallOptions` carries a per-call deadline, an idempotency key, an owner fence and a contract version. Every one of those fields already travelled and the dispatcher already acted on them; a C# caller simply had no way to set any of them, which made a .NET peer able to enforce the framework's safety rules and unable to invoke them. The process that most wants an owner fence is the one issuing the command. The per-call timeout also arms the local timer with the number the frame carries, so what the far end is told and what the caller actually does cannot drift apart.

**Bad wire data fails instead of becoming a plausible value.** Conversion returned `default` when a value would not convert - so a malformed integer arrived at a method as `0` and a malformed boolean as `false`. In control software that is worse than throwing: both are values a machine will act on, and a setpoint of zero is not a sensible reading of "the wire said something I could not parse". `RequiredArg<T>` and `TryGetArg<T>` join the lenient `Arg<T>`, results are read the same way, and one codec-neutral converter now owns the behaviour for both wire shapes. The tests run every case twice - once as MessagePack delivers it, once as JSON - because a method written against one shape and deployed on the other is the failure being prevented. Writing them found two real gaps in the converter itself: string enums under JSON, and element-wise array conversion.

**Readiness is separate from starting.** `StartAsync` returns before there is a link, deliberately - a peer may start before the thing it connects to - but that made `await StartAsync(); await CallAsync(...)` fail with `TransportError` rather than wait. `WaitUntilConnectedAsync` waits, and cancelling it abandons only the wait: a startup timeout no longer turns a slow server into a peer that never reconnects. `StartAsync`'s token is documented as the lifetime it actually is.

**Limits, because unbounded is the same as trusting the far end to be reasonable.** Hops, batch size and depth, identifier length, concurrent calls. The hop ceiling is the one an ordinary network reaches first: two peers each relaying for the other pass one frame between them for as long as the process lives, and nothing reports it. The concurrency gate prices a decision made earlier - transports do not await dispatch so a responder can call out and receive the reply, and unbounded fire-and-forget was the unpriced half of that. Beyond the ceiling a call is refused `Busy`, which certainly did not run.

**Tickets end.** The expiry on a receipt was metadata that nothing acted on, so a peer that died mid-command left its caller awaiting `Result` for the life of the process. It is an armed timer now, and disposing the client ends whatever is still waiting. Both report `UnknownOutcome` rather than a failure, because *may have run* is the true thing and the one a caller can act on. Progress handlers are isolated the way event handlers are.

**A deferred command finally closes its idempotency claim** - named as still open when the correctness fixes landed. The answer is produced long after the dispatcher returns, so nothing there could record it; the deferred object now records the outcome as it settles. A retry is dropped as in-progress while the command runs, and answered from the record once it has.

**Event publishing left the SignalR package.** `ISourceRpcEvents` is in the core with a `TransportEvents` implementation over any transport, so a peer on a broker or a socket.io client can announce things rather than only serve methods. Fan-out isolates a failed send: one unreachable subscriber must not stop the ones after it hearing the event.

**Authentication and authorization stopped being one setting.** Pinning a name to an authenticated identity says the name is not a lie; it says nothing when the connection never authenticated, so "pinning is on" read like "authentication is required" and was not. `RequireAuthenticatedPeers` fails closed. `ISourceRpcAuthorization` answers four questions - announce, carry, invoke, subscribe - and the last is not redundant: a method can be write-protected while the events from the same instance carry the data the method would have returned. Carried names are filtered one at a time, because a bridge legitimately carrying one cell must not thereby speak for another.

43 C# tests, 26 C# interop tests, 27 SignalR, and the client smoke test.

Still open, and named rather than absorbed: a C# peer cannot itself be a bridge; cross-language conformance is documented rather than executable, so TypeScript remains the de facto specification; a claim stranded by a process crash is held until the store expires it; MQTT presence is unsigned and wants a tested broker-ACL story; and method semantics are undeclared, so a key is honoured whenever one is sent rather than only where a method says repeating it is unsafe.


### The C# packages: six correctness defects, found by review and each pinned by a test

An external review of the framework at 5.0.1 marked the .NET packages **preview** for industrial command use, on three grounds. All three were real, and reproducing them turned up three more. None of these could be seen from the far end of a wire, which is why a cross-language suite that exercises every one of these semantics had them all passing.

**Idempotency did not prevent a concurrent duplicate, which is the promise the whole mechanism exists for.** The store held a null outcome to mean "claimed but still running", and a second attempt could not tell that apart from "no record at all" - so it was told it owned the key and ran the command alongside the first. For a non-repeatable command that is two pump starts. The contract now answers `Acquired`, `InProgress` or `Completed`, matching the TypeScript store's `'acquired' | 'in-progress' | outcome` rather than inventing a second rule; a duplicate that finds a key in progress is dropped rather than answered, because its caller is already waiting on the attempt that holds it. With 64 attempts released together, exactly one now acquires.

Three failures around it gained answers too. A store that cannot be reached, and a command that ran but whose outcome could not be written, both answer **`UnknownOutcome`** rather than success or `TransportError` - "it failed" invites a retry, "I do not know" says go and look, and for a non-repeatable command that is the whole difference. A key arriving where no store is registered is refused with **`IdempotencyUnavailable`**: carrying it and enforcing nothing told the caller a guard was applied when none was.

**Replies were correlated by id but not by peer.** Any frame with a matching correlation completed the call, whoever sent it. A correlation is hard to guess and that is not permission to answer - on a broker it travels in `correlationData`, where the broker and anything subscribed to the topic can read it, so a relay, a tap or a compromised bridge could answer somebody else's exchange. Pending calls and tickets are now held with the peer they were sent to, and a reply from anywhere else is refused and counted.

**Subscriptions were wrong in three ways at once.** Disposing any one handler told the far end to stop sending, so two subscribers to one event destroyed each other and the survivor went silent with nothing reported anywhere. The handler was registered only *after* the far end acknowledged, so an event emitted on acknowledgement was dropped. And nothing restored subscriptions after a reconnect, though the README promised a reconnecting peer keeps receiving - a peer's subscriptions live on its connection at the other end, so a reconnected client looked perfectly healthy and never received another event. Handlers are counted now, registered before the request goes out and rolled back if it fails, and taken out again on `ISourceRpcTransport.LinkEstablished` - a new signal every binding raises on every connection.

**On MQTT, a reply address only had to be somewhere on the network.** The check was "starts with the prefix, no wildcard" - which admits another peer's request, event and presence topics, the last of which was the attack the code's own comment claimed it prevented. A request may now name only its own `rsp` topic, with `AllowResponseTopic` for deployments that genuinely need another arrangement.

**The reply map was keyed by correlation alone**, and MQTT callers choose their own: two peers picking the same string meant the second silently overwrote the first one's return address, and the first caller's answer went to the second caller's topic. Keyed by peer and correlation now.

**The replay nonce was committed before the signature was checked**, so anyone who could observe a nonce could burn it - send it first with a wrong signature and the genuine frame that follows is refused as a replay, turning the guard into a way to suppress traffic. The freshness window is still checked first, because it is cheap and refuses a wildly wrong clock without computing an HMAC; the nonce is now recorded only after the frame is known to be genuine.

**The router removed routes by name without checking they were still that connection's.** A reconnecting peer takes its own name back, and the old connection's teardown is usually still running when it does - so the teardown deleted the route the new connection had just installed, announcing a connected peer offline and dropping its subscriptions. Removal is conditional on the exact route now. The race test fails on its second attempt against the old code.

**There is now a C# test project.** Fifteen tests, and they exist because none of these are reachable from the TypeScript suite: a duplicate claim is a race inside one process, a lost handler is invisible from the far end, and the router race needs two threads interleaved at one line. Each fix was checked by reverting it and confirming the right test - and only the right test - fails.

Still open from the same review, and named rather than absorbed: a deferred command holds its idempotency claim after the ticket settles; outbound calls cannot yet carry per-call deadlines, fences or keys; argument conversion still turns bad wire data into defaults instead of failing; dispatch is unbounded; and presence is unsigned on MQTT. Those are the next tranche, not this one.


### A store-backed node can accept writes, and the rule about writes is intact

`@source-repo/relational/writes` and `@source-repo/document/writes` create, change and remove rows. The design question was never whether that was useful — a database you can only read is half a tool, and prototyping against one over MCP is exactly where the other half is missed — it was how to add it without contradicting the sentence this repository states in four places: **a value is never written over this bus, a method is called.**

So there is no `$write` verb beside `$data`, and there is not going to be one. `$data` is answered by the dispatcher on every component's behalf, which is what makes it cheap; a write answered there would sit outside the deadline, the execution queue, the owner fence, the idempotency store and the post-queue re-checks unless each were re-invoked by hand, and that is a gate list somebody has to keep complete. Every verb here is instead an ordinary `@rpc` method with declared `semantics` and `effect`, so all of it applies by construction and none of it is special-cased. `authorize()` sees the resource and the patch in `params` and can rule per table.

**A separate class in a separate namespace, from a separate import** — the split `DockerService`/`DockerControl`/`DockerCreate` already makes, and for its reasons rather than for symmetry. Two namespaces are two `authorize()` surfaces, so reading is granted to everyone and writing to nobody; a subclass would have made "may call the database" one permission and would have made the read-only class's promise a lie by inheritance, since code holding a `RelationalService` could then have been holding a writable one; and the subpath export makes turning it on a visible line in a diff.

**Closed until a permission document says otherwise**, per table and per column, and absent means closed:

```typescript
writes: {
    work_orders: { verbs: ['create', 'update'], columns: ['status', 'note'] },
    recipes: { verbs: ['update'], columns: ['setpoint'] }
}
```

Data rather than a predicate, which is the argument the AI grants document already made: a console can render data and cannot render a callback, and a reviewer can diff a file and cannot diff a decision made inside somebody's closure. A malformed document refuses the node rather than being read as granting nothing. `columns` is **required** wherever `create` or `update` is offered, because an absent list would read as "every field" to whoever wrote it and to whoever reads it next, and those are the two people who must not disagree.

A rule naming a table or a column the store does not have is dropped **whole** — never narrowed to the parts that resolved, because the person who wrote it believed something false about that table and the next line may be wrong in a way nothing here can see — and the reason lands in `props.refused`. That is the same tripwire `props.unserved` is on the read side and it matters more: a misspelled table otherwise produces a node that refuses every edit to it, which reads exactly like deliberate policy, with nothing on any screen to say the policy was never loaded. Composing the node in with a usable document announces itself through `elevation()`.

**Every change carries a precondition, and it is required rather than available.** `update` and `delete` take the stamp the row was read under, and the only way to hold one is to have read the row:

```typescript
const read = await writer.getOne('work_orders', '4711')
await writer.update('work_orders', '4711', { status: 'done' }, read.stamp)
```

An optional precondition is one that gets omitted the first time somebody is in a hurry, and the failure it prevents — two edits where the second silently discards the first — leaves no trace anywhere for anybody to find later. `msgrpc.updateTopology` made the same call with `expectedVersion` and gave the same reason. A stale stamp answers `conflict` and writes nothing, and **the conflict carries no stamp**: returning the current one would put a blind overwrite one call away, which is a compare-and-set comparing against itself.

What the stamp covers falls out of the permission document rather than being a second decision — the fields the rule permits — so a trigger touching `updated_at` is not a conflict, while two callers writing different permitted fields of the same row are. A precondition that fails for a reason nobody can act on is one that gets switched off within a week.

The comparison happens under whatever hold the engine offers, and that turned out to be the third thing the three SQL flavours genuinely disagree about, after case-sensitive matching and where a missing value sorts. Postgres and MySQL take `for update`, because under their default isolation two callers can otherwise both read, both find the stamp they expected, and both write — the precondition failing to be a precondition, silently, in exactly the case it exists for. SQLite needs nothing, since this package's dialect serialises every statement onto one connection; that is a property of the dialect rather than of SQLite, so the flavour states it rather than the service assuming it. MongoDB needs no transaction either: the guard travels in the update's own filter, so the compare and the set are one operation on the server — which also means it works on a standalone `mongod`.

**`getOne` is served here and stays unserved on the read side**, which only looks like a contradiction. There the argument holds exactly — a caller wanting one row asks `getMany` for one id, and a verb existing only to be a worse version of another is not worth the wire. Here it answers something `getMany` does not carry at all.

The refusals are the feature, as they are on the read side. A field outside the rule is refused **and the whole patch with it**, because a patch half-applied and then rejected leaves a row in a state nobody asked for and the error names none of it. A value is checked rather than converted: `'80'` into a numeric setpoint is what JavaScript and MySQL will both happily make 80, and the one time the string is `'8O'` the column holds 0 with nothing reporting it. A date arrives as an ISO string and never as a number, since epoch seconds and epoch milliseconds are both ordinary conventions. An update naming the id is refused, because a row that renames itself leaves every reference dangling — while the same column stays creatable, which is what a natural key needs. A required column a `create` omitted is named here rather than by three engines in three sentences none of which was written for whoever is holding the console. And a view is refused outright: whether a write through one reaches a table is the engine's business rather than this node's.

**No `updateMany` or `deleteMany`.** react-admin has both and a grid's multi-select wants them, but a bulk delete over a filter is the single most dangerous call this surface could offer and the one where a mistaken predicate is indistinguishable from a correct one until the rows are gone. Fifty changes are fifty calls, each with its own precondition and its own audit line.

**The questions are in `packages/conformance`**, which is where the claim gets tested rather than asserted: nine write questions asked of SQLite, Postgres and MySQL, and of MongoDB beside them. A stamp that meant one thing over SQL and another over a document store would be a compare-and-set that holds on one backend and not the other, and the symptom is a lost update, which leaves nothing behind. The stamp's own encoding is pinned separately, with literal digests, in the library's `DataWrites.test.ts`.

**Over MCP** there are now `list_writable`, `read_row` and `write_row`. They add no capability — `call_method` could already invoke `sql.write.update` on any peer the server can reach, and this is the same relationship `set_state` has to `call_method` — so there is no new flag and no new warning. `write_row` will not fetch the stamp it insists on, deliberately: a tool that read the row and immediately wrote it back would satisfy the precondition by construction, and the lost update would go through every time.

## 5.0.1

`@source-repo/rpc` only, and documentation only: the README named three of the eight packages in this repository, and npm serves a README from the tarball rather than from the repository - so the list nobody could see was the one on the package page.

## 5.0.0

A major because the wire changed. MQTT peers speak frame version 3 on the `msgrpc/v2` topic prefix; connection transports - socket.io and SignalR - speak the flat frame. A peer on the old numbers does not talk to a peer on the new ones. Nothing running breaks on its own: a socket.io server serves both layouts from one listener, and the prefix change is what keeps the two MQTT populations from meeting. But there is no upgrade path that leaves half a network behind, which is what the number is for.

The .NET packages carry the same version, so one number describes the release in both languages.

### A review pass, and the frames a peer gets sent by something that wishes it harm

Three reviewers were pointed at the new code. What they found was not in the protocol - it was in what happens *around* a signature, and the worst of it needed no key at all.

**One unsigned frame killed the process.** The payload was MessagePack-deserialised before anything checked the signature, under options the library's own documentation describes as omitting all protections - including any bound on nesting depth. A few kilobytes of repeated `0x91` is a `StackOverflowException`, which .NET cannot catch: the `try` around the call, and the promise that one bad frame cannot take a peer down, were both simply void. Reproduced end to end - the peer exited 134 mid-suite - and now fixed in both halves: the payload is not read until the frame carrying it is verified, and it is read as untrusted data. `MqttHostileFrames.test.ts` and one case in the socket.io suite send the bomb and then assert, from *outside*, that the peer still answers, because a process killed this way returns no error to assert on. The socket.io binding had the same exposure with no signature step to sit behind at all.

**The replay guard bounded nothing.** It evicted by age, and everything inside the freshness window is by definition too young to expire - so under load it grew to arrival-rate times the window and made every later message walk the whole table looking for something to drop. Since it runs before signature verification (which is the right order - the reverse lets an attacker force an HMAC per packet), unsigned garbage was enough to drive it. Now bounded by count as well as age, oldest first.

**A crafted `mr-ts` threw its way out of the receive path.** `Math.Abs(long.MinValue)` throws, and that value is one the sender picks. The freshness window is now checked by comparison rather than by subtracting attacker input.

**A signed frame could redirect somebody else's answer.** Any peer holding a key for its own name could publish a signed `event` carrying another exchange's correlation and a reply address of its choosing; the answer went there. `responseTopic` is inside the signature and was faithfully attested - the missing part was authorisation, not authenticity. Only a request may now name a reply address, and it must be inside this network's own prefix. Presence updates likewise act only on the exact words `online` and `offline`, so an answer misdirected onto a presence topic can no longer evict a peer everywhere.

**The verifier now names who it proved a frame is from**, rather than returning a bool, and the transport re-checks that name against `mr-src`. A verifier resolving keys loosely could otherwise remove the binding between a signature and a name - which is the whole property signing provides here - with nothing in the library noticing.

Also: the reply table and the nonce table are both bounded now; a verifier that throws refuses rather than escaping the refusal path; and `responseTopic` is canonicalised request-only, matching the TypeScript verifier byte for byte.

### socket.io: a disposed transport that would not stop dialling, and a peer list frozen at boot

**`DisposeAsync` did not stop the connect loop.** `ConnectAsync` runs socket.io's own retry internally and, with unlimited attempts against a server that is down, never returns and never throws - so a disposed transport kept dialling for the life of the process, and connected minutes later to a server nobody had asked it to reach. It takes the cancellation token now.

**The peer list only ever read the first message.** A server sends the full set once and then a single `{peer, state}` for every change after that. Reading only the snapshot means an HMI shows whoever happened to be online at the instant it connected - for ever: a controller that comes up later is never listed, and one that dies is shown healthy. The SignalR client had it too.

**An application handler that threw disabled the server-restart recovery.** `PeersChanged` was invoked from socket.io's own callback, ahead of the retry, outside any try - so one unrelated NullReference in a peer-list handler reintroduced exactly the orphaning the retry exists to prevent, silently. It is invoked last now, and wrapped.

Also: the start guard is interlocked, so two callers cannot each build a socket and announce the same name; refusals raise a `Rejected` event rather than going only to a logger that defaults to discarding everything; frames are checked for version, source and target on arrival instead of a missing `v` defaulting to the version this build happens to speak; the msgpack encoder omits absent fields, so both codecs put the same frame on the wire; the reconnect bound is 5 s rather than the 30 s steady-state backoff, which had a .NET peer stranded half a minute after a blip every TypeScript peer rode out; and `Path` is renamed `EnginePath`, because it is engine.io's endpoint and not the namespace - a namespace put there produced a peer that never connected while the server logged nothing at all.

### The tests were passing for the wrong reasons

The reviewer of the tests found the replay case was not replaying: it re-sent with a different correlation, which the signature covers, so the frame was refused for its signature and the test would have passed with replay protection deleted entirely. The tamper loop re-read its baseline each iteration, so on a slow runner a late reply from one case landed inside the next case's baseline and *every* tampered frame could be answered with all assertions green. And the silence assertions leaned on a control in a different test, on a different peer, through a different code path - so with the peer not running at all, three of them reported green.

Each silence test now proves the same construction is answered first, on its own peer; the tamper loop holds one baseline; and the replay sends the captured bytes unchanged. Two fields the signing revision was actually argued from - the content type and the reply address - were never tampered with and now are, along with a signed deferred answer and a signed event, which is where `mr-deferred`, `mr-outcome`, `mr-seq` and `mr-epoch` finally get verified by something.

Fixing that immediately caught a fourth: the unsigned-frame test was passing `undefined` for the secret, which in JavaScript selects a parameter's default - so the frame it sent to prove unsigned frames are refused was signed.

The Windows CI job had been given the require-flags for peers it never starts, which would have failed every MQTT suite there and hung the socket.io hook waiting 45 seconds for a peer nobody launched.

### `SourceRpc.SocketIo` — a C# client, and two deadlocks the other bindings were also carrying

The third binding, and a client only: socket.io's server is a Node library with no maintained .NET equivalent, so a .NET process that needs to be dialled into serves SignalR instead. What is actually written here is an encoder, a decoder and two event names — everything else is the shared dispatcher and client, which is what the seam was cut for.

Two bugs, both found by one test that nothing else in the suite had asked for: **the C# peer calling back the other way while it is answering a call.**

**A responder that calls out mid-invocation deadlocked, on every binding.** socket.io, MQTTnet and SignalR all wait for the receive callback to return before delivering the next message, so awaiting the responder there means nothing arrives until it finishes — and a responder waiting for a reply is waiting for something that cannot be read until it stops waiting. It resolves as a timeout on the *outer* call, which reads as a slow method and sends the search nowhere near the transport. All three bindings now start the dispatch instead of awaiting it, which is what the TypeScript client has always done: socket.io's JavaScript client never awaits a listener either, so this is the ordering the protocol was written against. Frames are correlated and events carry a cursor, so nothing above depends on being *handled* in arrival order.

**A server restart orphaned every .NET socket.io peer, permanently and silently.** socket.io deliberately never auto-reconnects after a server-initiated close — which is exactly what a restarting server sends on its way down. The process stayed healthy, sends threw "not connected", and nothing ever tried again. The TypeScript client transport has carried the workaround for a while; this one now does too. Found because the interop suite failed the second time it was run against the same peer, and the peer's own log ended with `link closed: io server disconnect`.

### Signing on MQTT

The `mr-nonce`/`mr-ts`/`mr-sig` properties were named and nothing produced or checked them, which is recorded two entries below as known and unfixed. `MqttSigning` now produces and checks them: HMAC-SHA256 out of the box, a `ReplayGuard` that refuses a repeated nonce or a stale timestamp, and refusal of any unsigned frame once `Verify` is set — because signing that can be bypassed by omitting the signature is not signing.

This matters more on MQTT than on the other carriers, and structurally rather than by degree: peers connect to a broker rather than to each other, so a receiver has no connection to attribute a frame to and `mr-src` is only a claim. socket.io and SignalR authenticate the connection once and pin the source to it, which is a stronger claim checked in one place — which is why neither of those bindings signs frames and neither needs to.

**The canonical bytes had to be byte-identical with the TypeScript library's, and were not.** System.Text.Json escapes more than JavaScript does — `<`, `>`, `&`, `+` and every non-ASCII character — and "more escaping" is not a safe difference: it is a different byte sequence, and the signature over it verifies nowhere while looking like a wrong key, a clock skew or a broker problem. So the JSON is written out by hand against ECMA-262's QuoteJSONString, and `MqttSigningInterop.test.ts` computes the same bytes in both libraries and compares them. It earned its place immediately: a matched surrogate pair was signed with its low half escaped, because the loop met that half again on the next turn and read it as a lone surrogate.

`MqttSignedInterop.test.ts` then checks the whole thing on a real broker with real HMACs, from outside the library — an unsigned frame refused, a wrongly signed one refused, a captured frame that cannot be sent again, and each covered field tampered with **one at a time**, signing one set of properties and publishing another. That last part is the difference between a test that passes and one that means something: changing a property *and* the nonce would fail on the nonce, and prove nothing about the property. Every case is anchored by a positive control — the same raw construction, honestly signed, is answered — so "nothing came back" is a refusal rather than a topic typo.

### `SourceRpc.Mqtt` — a C# peer on a broker

The second binding, and the one that tests whether the seam was real: it shares no wire format with the first. SignalR carries the flat frame as a typed object; MQTT carries the `mr-` property layout with the body alone in the payload, and the two have no bytes in common. What they share is `RpcFrame`, the dispatcher, the client and every semantic below them - so the binding is a frame mapping and a class that moves packets, and calls, errors, events, subscriptions, fences, idempotency and deferred answers all behaved without being written twice.

**The MQTT frame is unchanged, deliberately.** Moving it to the flat frame would have made this binding trivial and cost the layout everything it exists for: the topic carries the addressee so shared subscriptions can load-balance, `responseTopic` and `correlationData` are MQTT's own request/response, `messageExpiryInterval` lets the broker drop a request whose caller has gone, the `req`/`rsp`/`evt` split is what least-privilege ACLs are drawn on, `mr-code` is readable in MQTT Explorer without decoding, and a plain mqtt.js peer can take part with no msgrpc code at all. One shared *model* with two spellings is the right shape; one shared spelling would have been a worse protocol wearing tidier code.

`packages/rpc/src/MqttInterop.test.ts` puts a TypeScript peer and a C# peer on one broker and checks the pairing: a call, an error with its code, an owner fence refusing a stale generation, an idempotency key answered from the record, a subscription delivering stamped events, and a deferred method answering twice. Five passed on the first run; the sixth failed with `this call arrived over a link that cannot deliver a later answer` - the dispatcher's own guard, refusing to defer because `SourceRpcClient` dispatched without a reply channel. The guard was right and the client now supplies one.

Also found: **MessagePack 2.5.192 carries known vulnerabilities**, and `TreatWarningsAsErrors` turned NU1902 into a build failure rather than a warning nobody reads. Both projects now pin 2.5.302 - the version `Microsoft.AspNetCore.SignalR.Protocols.MessagePack` already resolves - so one MessagePack is loaded rather than two majors in a process that holds both bindings.

Signing was named here as missing and is no longer — see the entry above. `mr-nonce`/`mr-ts`/`mr-sig` were declared in `Mqtt5Frame` and produced by nothing, so a C# peer could not join a signed network at all.

### A ticket's answer is no longer lost when it arrives before the caller holds the ticket

Both sides had a window between a deferred call being answered and the caller having something to put the answer on, and both dropped what arrived in it. The window is not exotic: completing the receipt's promise *queues* the caller's continuation rather than running it, so the far end's next frame can and does arrive first.

**In C# the answer itself was lost**, which is the serious half. A ticket frame arriving before the ticket existed was discarded, so `resolved` could vanish and `Result` would never complete - a caller waiting for ever rather than being told anything. Reproduced with a method that resolves *before* returning its receipt, which sends the outcome ahead of the answer it belongs to: `INSTANT: LOST - the answer never arrived`. The sink now holds early frames and replays them in order when the ticket opens, and says whether that already settled it so the correlation is not tracked for nothing.

**In TypeScript the answer survived** - a promise remembers what it was resolved with - **but progress did not.** `TicketRegistry.open` drains its early queue before the ticket object exists, so held progress went to an EventEmitter with nothing on it; and progress arriving between the receipt and the caller's `ticket.on('progress', …)` went the same way. Progress is now held until the first subscriber and replayed to it, bounded at 64 and dropping oldest first, because a caller arriving late wants where the work has got to rather than where it began.

That closes something written down here two entries ago as known and unfixed, and it lets the MQTT deferred test assert progress again - an assertion that had to be weakened when it was written, because on a broker round trip with a loaded event loop the loss was routine rather than rare. Checked in both directions: removing the hold makes that test fail.

### The C# side enforces deadlines, fences and idempotency, and can answer later

The three semantics the main library treats as central, now checked in front of the responder rather than described as somebody else's problem. Verified across languages: the interop suite drives each of them from a real TypeScript client against the real C# hub, over both hub protocols.

**The owner fence is enforced**, and refused where it cannot be. Register an `IRpcOwnership` and a fenced call is compared against it; register none and a fenced call is refused rather than run. Both directions fail closed, including a fence against an instance no record covers — because a peer that accepted a fence it could not check would be telling the caller its command had been guarded when nothing had.

**Idempotency answers a repeat from the record.** The outcome is written before the caller is answered, since a crash between running and recording leaves a command that ran and can be run again; and a store that cannot be reached refuses the command, because failing open would mean the one condition under which double execution is possible is also the one under which nothing is checking for it. `InMemoryIdempotencyStore` is provided and honest about forgetting on restart.

**A deadline is checked immediately before running**, not only on arrival: what that catches is the time spent queued inside the process, which the caller cannot see and a broker cannot deduct.

**A method can answer later.** `call.Defer<T>()` returns a handle whose receipt the responder returns; the caller is told at once that an answer is coming and gets it, with progress on the way, down the same link. The ticket's id is the call's own correlation, so nothing is minted and a forged answer has nothing to attach itself to. `CallDeferredAsync<T>` is the C# caller's side of it.

Found while wiring it: **a deferred answer cannot be sent through the hub's own `Clients`.** It is sent after the invocation that produced it, by which time the Hub instance and everything hanging off `Context` has been disposed - so the reply channel captures the connection id and goes through `IHubContext` instead.

### The C# side becomes a package a .NET application can use without knowing its internals

Two packages now, and the split is the load-bearing part: **`SourceRpc`** holds the frame, the dispatcher, the client, routing, the error model and telemetry, and depends on nothing but the BCL; **`SourceRpc.SignalR`** holds a hub and a client transport, and is the only one that needs ASP.NET Core. A device running an MQTT client should not carry a web framework to get a protocol, and now it does not have to.

`ISourceRpcTransport` is the seam a binding implements — start a link, send a frame, raise an event when one arrives — and correlation, deadlines, subscriptions, error mapping and dispatch stay in the core where they are written once. Three transports each reimplementing those is how they come to disagree about what a timeout means, which this library already prevented once on the TypeScript side. `TransportContract` records what a binding has to get right. **socket.io will be a client only**: there is no reasonable C# socket.io server and none is needed, since the TypeScript side already serves socket.io.

**A .NET process can now call out as well as answer.** `SourceRpcClient` over any transport, with `SignalRClientTransport` as the first: `CallAsync<T>`, `SubscribeAsync`, correlation, a deadline that travels as `ttl`, and error codes that survive the round trip. A client is a peer, so it can also be called - give it a dispatcher and frames addressed to it are served down the same link.

Registration is now two lines and mentions nothing internal:

```csharp
builder.Services.AddSourceRpc(o => o.Name = "vs-automation").AddResponder<AutomationSurface>();
app.MapSourceRpc("/rpc");
```

An application sees `RpcInvocation` rather than the frame — `Arg<T>(0)` reads the same under either hub protocol, `Deadline` is a moment rather than the duration the wire carries, `Source` has been checked rather than asserted — and `ISourceRpcEvents` rather than an implementation. Options are validated at startup, because a peer with no name is a misconfiguration and a plant service that fails to start beats one that runs unreachable.

**Errors are deliberate now.** `SourceRpcException` carries the code a caller acts on and a message written to be read; anything else that escapes becomes `Exception` with a generic message while the real one goes to the log, because a vendor exception can carry a file path, a connection string or the innards of a COM error. `IncludeExceptionDetail` opts in.

**Telemetry and logging are first-class**, through `System.Diagnostics.Metrics` and `ActivitySource` rather than an OpenTelemetry dependency: `.AddMeter("SourceRpc").AddSource("SourceRpc")` in a host's own exporter picks up calls, durations, errors, frames, routing failures, connections and subscriptions. Tagged with path and method and never with arguments or results - a dimension is a label on a time series, and plant data does not belong in one.

Two failures worth recording, because both were silent:

- **A SignalR hub type must be public.** Made internal - as hiding implementation suggests - it is discovered, mapped and connected to, and then never invoked, because SignalR builds its method executor by compiling an expression tree that cannot reference an internal type. It is public with a comment saying why, rather than by oversight.
- **A dependency cycle produced the same symptom.** Dispatcher needs the responder, the responder needs the event publisher, the publisher needs to know who is subscribed: a container that cannot build any of the three yields a hub whose methods are never invoked, an `invoke` that never returns, and nothing in the log. The subscription registry is shared rather than owned, and the test host turns on `ValidateOnBuild` so the next one is a startup exception naming the cycle.

### Fixes from an outside review of the SignalR binding

An external review of `main` found several things, and the concrete ones checked out against the code. Four are fixed here; the rest are recorded below rather than rushed.

**The first connection did not retry, and the README claimed it did.** `withAutomaticReconnect` covers a dropped link and explicitly not a failed initial `start()` — which Microsoft documents and which this transport's own README quoted while promising the opposite. So a peer that came up while its hub was down tried once and stopped, and the maintenance window the retry policy was written for was exactly the case it did not cover. `open()` now retries on the same schedule and never rejects: the transport is not ready until it succeeds, `ready()` says so by timing out, and a send throws rather than being discarded. `close()` disarms a pending retry, or a shutdown would bring the link back up under a transport its owner had finished with.

**The C# README taught a signature that no longer exists.** The responder example still took `JsonElement? args` and indexed it, which both fails to implement `IRpcResponder` and teaches precisely the JSON coupling `frame.Arg<T>()` was introduced to remove — in the first code a C# integrator copies.

**`OnDisconnectedAsync` did not await its presence broadcast.** Fire-and-forget is wrong here because presence convergence is routing correctness rather than telemetry: a peer that is gone but still listed is a peer frames are still addressed to, and an unobserved task can be abandoned outright during the host shutdown that most often causes the disconnection.

**`LangVersion` was `latest`**, which makes a published package's language surface depend on whichever SDK compiled it. Pinned to 12, the version that pairs with net8.0.

Recorded and **not** fixed, because they are one design change rather than four patches: the hub does not pin `frame.Src` to the connection's authenticated identity, it ignores `PresenceAnnouncement.Carrying`, and its initial presence snapshot omits the `Shapes` dictionary it has a field for. The first is the serious one — any connected client can claim any name, and subscriptions are keyed by that name — and the reviewer is right that it and `carrying` are the same question: which identities is this connection entitled to originate and route for? `SocketIoServerTransport` already answers it for its own transport; the C# hub should answer it the same way, and that is worth designing rather than patching.

### The C# hub is packable as `SourceRpc.SignalR`

`npm run pack:csharp --workspace=@source-repo/signalr` produces a NuGet package and a symbol package. The reason is a `ProjectReference` across repositories: it is a relative path out of one working tree and into another, which resolves on the machine that wrote it and ships broken from anywhere else — and it is already how the hub was being consumed.

The version tracks `@source-repo/signalr` and therefore `@source-repo/rpc`, for the reason the workspace versions together at all: this hub implements a wire format the library defines, and a number that cannot say which version of it was implemented is a number saying nothing.

The XML documentation ships, so the reasoning in these types reaches a consumer's IntelliSense. `CS1591` is suppressed with it: under `TreatWarningsAsErrors` it demands a sentence on every public member including those whose names have already said it, and `/// The peer.` above `public string? Peer` is the mechanical comment this repository's style exists to avoid.

### The Windows job runs the interop tests too, which is where the hub will live

The C# hub's reason for existing is a .NET process driving Visual Studio, which is a Windows process — so testing it only on Linux was exercising it everywhere except where it is going to run.

On Windows the hub and `npm test` share **one step**, which is the one place the two jobs differ in shape. A step's shell exiting is not documented to leave a child running, and measured on a real Windows machine a process started with `Start-Process` dies when the session that launched it ends — with and without `-NoNewWindow`, so it is the session teardown rather than the switch. That teardown belongs to OpenSSH rather than to a runner, so it does not prove Actions would do the same; what it proves is that "the hub survives the step" was an assumption nothing available could check. Keeping the hub inside the step that uses it removes the assumption rather than betting on it.

The wait is now `tools/wait-for-port.mjs`, shared by three places that were about to hold three copies of it — and node rather than a shell loop because it is the one interpreter both runners have and it behaves the same on each.

Worth recording, because it is expensive to rediscover: **`Microsoft.NETCore.App` 8 and `Microsoft.AspNetCore.App` 8 install separately.** A machine can run a `net8.0` console application perfectly and still fail a hub at launch with `Framework: 'Microsoft.AspNetCore.App', version '8.0.0' not found` — and a console self-test cannot catch it, because a console application never asks for the web framework. Installing the SDK brings both, which is what a hosted runner has; a machine with only the runtime placed by hand may not.

### CI runs the SignalR interop tests, and its broker accepts connections again

The interop suite has been skipping on every run since it was written, because a GitHub runner has no .NET SDK and therefore no hub to talk to. `actions/setup-dotnet` and a step that builds the hub, backgrounds it and waits for its port fix that, with `SOURCE_RPC_REQUIRE_SIGNALR=1` so the skip is a failure rather than a quiet ✔ — the same bargain `SOURCE_RPC_REQUIRE_BROKER` already makes.

Not a service container, because the hub is built from this repository rather than pulled: it cannot exist before the checkout that contains it.

**The broker was already refusing every connection**, which is the more urgent half. EMQX 5.9 enables password authentication out of the box, so an anonymous CONNECT — every peer in this suite — is answered `Not authorized`, while the TCP port opens perfectly happily. The wait step passed and the run died immediately after. `EMQX_AUTHENTICATION: '[]'` is the one override that works: setting `enable = false` on the existing entry replaces rather than merges it, and EMQX then refuses to start at all with `missing_mechanism_field`. The same line is in `docker-compose/docker-compose.yml`, so a CI failure stays reproducible with one command locally.

### The SignalR binding speaks MessagePack as well as JSON

Both protocols are registered on the reference hub and the client picks at negotiation, so one process serves either kind of peer and `useMsgPack` is the only thing that differs. The interop suite runs **every test twice, once per protocol**, because the serializer is the half of this binding most likely to be subtly wrong and a JSON-only pass would leave the MessagePack path unexercised until somebody's first day using it.

Two things had to change in `RpcFrame`, and both fail at the first frame rather than at build:

- **Every property needs `[Key("…")]` beside its `[JsonPropertyName("…")]`.** The two attribute families do not see each other, so annotating for one leaves the other sending PascalCase at a client that will refuse it.
- **Every other public member needs `[IgnoreMember]`.** MessagePack refuses to build a formatter at all when one lacks it — `all public members must mark KeyAttribute or IgnoreMemberAttribute` — and it throws from a type initializer on the first frame, so the hub simply answers nothing. `ArgCount` was that member. It also wanted `[JsonIgnore]`: as a public getter, System.Text.Json had been serializing it into every JSON frame as a field the specification does not have, which the TypeScript side ignored and nobody noticed.

`Body` is now `object` rather than `JsonElement`, since `JsonElement` is a System.Text.Json type and means nothing to MessagePack — a frame declaring one can be carried by exactly one of the two protocols. `frame.Arg<T>(index)` reads an argument under either, including MessagePack's habit of choosing the narrowest integer that fits, so a JavaScript `7` arriving as a `byte` and `70000` as an `int` is invisible to the method.

**What MessagePack buys is bytes.** A `byte[]` returned from C# reaches a TypeScript caller as a `Uint8Array`; over JSON the same method answers with base64 text. Nothing is lost either way, and the tax MessagePack removes is the caller having to know which. That is now asserted rather than claimed.

### `@source-repo/signalr` — a .NET process as an ordinary peer

The .NET world does not run socket.io servers; it runs SignalR. So a C# process wanting to join a Source RPC network — a Visual Studio automation host, say — could not be reached directly, and the way round it was to put a broker between the two and give it a topic of its own. That works, and it is a great deal of machinery for two programs on one machine: it makes a local integration depend on infrastructure being up, and it puts a network hop between a caller and a process it could have spoken to directly.

**This is the payoff from the flat frame rather than a new protocol.** A frame carries its own `src` and `tgt`, so a transport needs only "put this frame somewhere, get that one back" — and SignalR's hub methods are exactly that. The mapping is a page long, `toWireFrame`/`fromWireFrame` are reused unchanged, and a hub implements the *same specification* a socket.io peer implements rather than a SignalR-shaped variant of one. That the second binding cost so little is the argument for having done the earlier steps at all.

`SocketIoFrame.ts` became `FlatFrame.ts` accordingly, since the frame was never socket.io's, and `docs/socketio-frame-spec.md` became [`docs/flat-frame-spec.md`](docs/flat-frame-spec.md) with a binding section for each. The neutral frame and its flat form are now **exported** from `@source-repo/rpc`, because a transport can live outside the package and this is what one needs.

**Client only, and there will not be a server.** A SignalR server *is* ASP.NET Core; there is nothing to host one with from Node. The direction is fixed — the .NET process is the hub and this dials in — which is the direction the problem has anyway.

**The frame travels as an object rather than as bytes**, the one place this binding differs in substance. SignalR has a serialization layer and typed hub methods; handing it a blob we encoded ourselves would mean the hub receives `byte[]` and decodes it by hand, throwing away the one thing SignalR does for a C# author. `codec` therefore selects the hub protocol instead of doing the encoding.

A reference hub is in [`packages/signalr/csharp/`](packages/signalr/csharp/) — frame records, routing, the `IRpcResponder` a process implements, and `RpcEvents` for what it pushes. **It compiles and it runs**: `csharp/testhost` hosts it, and `Interop.test.ts` drives a real `RpcClient` against it over a real SignalR connection — a call, a thrown exception, a subscription, an unsubscribe, and the event cursor. Those tests skip without a .NET SDK, with `SOURCE_RPC_REQUIRE_SIGNALR` to turn the skip into a failure the way the broker suites do.

Events are the part worth reading twice, because the hub is where a peer's *observability* comes from and the semantics are easy to get subtly wrong. The count runs whether or not anyone is subscribed — a subscriber that joins late wants to know how many went past while it was away, and a counter that stood still cannot tell it. A repeated subscribe is one subscription, answered `ok - already exists`, because a client replaying after a reconnect must not end up served twice. And a subscription is keyed by peer name rather than connection id, so a reconnecting peer keeps receiving without re-subscribing.

Separate package because `@microsoft/signalr` brings 161 packages with it, and every consumer of `@source-repo/rpc` — browser bundles included — would otherwise pay for them.

### socket.io speaks the same protocol, in one flat frame

The last of the three steps in `docs/wire-format-parity.md`, and the one the whole exercise was for: a peer written outside TypeScript now implements msgrpc **once**. The new layout is written down in [`docs/flat-frame-spec.md`](docs/flat-frame-spec.md).

The old frame was `JSON header` + `'$'` + `msgpack(Message)`, and its real cost was never the nesting — it was **two encodings in one frame**, which means a boundary that has to be found before either can be read. Because the header is JSON, a peer name containing a `$` puts one inside a quoted string where it is data rather than punctuation, so finding it means walking the bytes with JSON's own quoting rules: brace depth, string state, backslash escapes, and a 1024-byte limit past which frames are dropped. That is `findHeaderEnd`, and `Framing.test.ts` and `Resilience.test.ts` exist because this library got it wrong first. Asking a third-party implementer to reproduce it byte-exactly, on pain of silently losing frames, was the actual barrier.

**One map in one encoding has no boundary to find.** Reading a frame is `codec.decode(bytes)` — the call a caller already had to make for the body — and the field names are the MQTT 5 property names with `mr-` removed, so the two wire formats now differ only in their framing and share their vocabulary. `time` and `seq` are gone, having been carried and never read; `nonce` and `sig` were never here, because socket.io authenticates the connection once at the handshake and pins each frame's source to it, which is a stronger claim than a per-frame signature and is checked in one place.

**A batch travels as one frame carrying many**, which is new. MQTT 5 has to unpack a batch into one publish per call — one correlation per publish is its rule — so this is the transport where the envelope actually pays, and now it does.

**Version negotiation is the socket.io event name.** A peer emitting `frame` speaks v2, one emitting `message` speaks v1, and a server registers both and answers each peer in its own dialect — so an upgrade needs no coordination and no configuration. Presence gained a `v` field for the one case frames cannot cover: a peer that announces itself and then only listens, which a server must be able to address without ever having heard a frame from it.

The honest limit, stated because it is the one that bites: **a v2 client against a pre-v2 server emits an event that server has no listener for**, and socket.io delivers it to nobody, so the call times out with nothing said. There is no handshake in which the client could learn better first. `SocketIoClientTransport` therefore takes a `frameVersion`, and this is one more reason the packages that track `rpc` version with it.

### The frame is the protocol now, and MQTT 5 carries all of it

The owner fence below was not the only thing the MQTT 5 layout could not say. Three more travelled over socket.io and were dropped at the broker without a word, and they were all missing for one structural reason: the frame lived inside the MQTT transport, so *adding a field to the protocol* and *deciding what MQTT calls it* were the same act — and a field could be added to the payload, honoured by socket.io, and never noticed to be absent here.

**`RPC/Frame.ts`** is that frame, moved out and made the thing both transports map to. `Transports/Mqtt5Frame.ts` keeps only the `mr-` names. The rule now has somewhere to live: anything a `Message` can carry must be representable in the frame, and a payload field a receiver *acts on* belongs there before it belongs in any transport.

What that recovered, over MQTT 5:

- **Deferred methods answer at all.** `RpcMessageType.ticket` had no case in `toOutboundFrame`, so every later answer was reported unroutable and discarded: `defer()` produced a receipt and then nothing, and the caller waited out the ticket. `mr-kind: ticket` with `mr-outcome` carries it, and `mr-deferred` marks the receipt so a caller knows to wait rather than settling with the receipt in place of the answer.
- **A deferred answer goes where the caller asked.** `takeReply` was *"one request, one answer: taking it also forgets it"*, so the receipt consumed the note and every later answer fell back to a derived topic in this peer's own encoding. A caller that named its own response topic got its receipt where it asked and its actual answer on a topic it was not listening to, in an encoding it never agreed to. The note is now held until the reply that ends the exchange — `isFinalReply` — and released there.
- **Events carry their cursor.** `seq` and `epoch` were dropped, so a subscriber could only ever report "saw nothing" and never "missed nothing". `mr-seq` and `mr-epoch` carry them.

All four are covered by the signature, on the same reasoning as the fields version 2 added: `mr-deferred` decides whether a caller keeps waiting, `mr-outcome` decides whether its promise settles and which way, and the cursor is the arithmetic behind a gaplessness claim. Since **`mr-v` was still unreleased at 3**, this rides that bump rather than minting a fourth — one wire break instead of two.

**A ticket is the one place a correlation carries more than one publish**, and that is deliberate rather than smuggled: unlike a batch, which the spec still refuses to represent, a deferred call has *one* correlation and several publishes against it, which correlation data already expresses, and `mr-outcome` says which one ends it.

Known and not fixed here: **progress delivered before a caller can attach a listener is lost**. A caller only receives its ticket once the receipt arrives, and `TicketRegistry.hold` drains its early queue before the ticket object exists, so progress that arrived in between is emitted to nothing. Over socket.io the window is sub-millisecond and nobody noticed; over MQTT it is a broker round trip wide. That is a defect in the ticket API rather than in the wire format, and it wants buffering progress until the first subscription.

### The owner fence now reaches the far end over MQTT 5

A fenced call carries the owner generation its caller observed, and the target refuses `OwnershipChanged` when that is no longer the generation that rules. Over MQTT 5 it carried nothing: `toOutboundFrame` had no case for `fence` and no user property existed to put it in, so the fence was dropped at the transport and `fenceRefusal` at the far end found nothing to check. **Every fenced call over MQTT 5 arrived unfenced, and ran.**

The failure is worth stating precisely, because it is the opposite of the usual one. A fence is checked by being present, so losing it does not weaken the check — it removes it, and the caller cannot tell, because what comes back is an ordinary successful result. The commands most likely to meet it are the ones it exists for: a queued or redelivered command is exactly the one whose ownership may have moved while it waited.

`mr-fence` carries it now, and the signature covers it — which is the other half. Of every signed field this is the only one an attacker need merely **delete** rather than alter: an unsigned fence could be stripped by anything on the path, turning a command meant to be refused under a new ownership into one that executes, with no key involved and nothing at either end to notice. So **the signed frame version goes 2 → 3** and a version 2 signature is no longer honoured, by the rule the 1 → 2 bump was made under: a receiver that accepts either lets the sender choose the weaker. The gate still applies only to signed frames, so an unsigned plain-MQTT peer announcing an older `mr-v` is unaffected and interop is intact.

Found by reading the two transports side by side rather than from a failure, which is the uncomfortable part. `Topology.test.ts` exercises the fence thoroughly over socket.io and passed throughout; no MQTT 5 test asked. Both now do.

### Reading is observation, including the reads the library performs itself

The AI boundary's second rung says a badged principal may observe wherever ordinary authorization allows — and three of the four things "observe" ought to mean were quietly on the other side of it. Nothing refused them on purpose; they were classified as something they are not, by a default that is right everywhere else.

`describe()` declared no semantics, so it defaulted to `operate`. That made **asking a node what it serves** a write: the one call every console and every model begins with, refused for exercising a power it does not exercise. It is declared `query` now, like every other method on that class, which is what it always was.

`$data` and the `$context` service's `read` and `subscribe` are answered by the handler before any exposed method is looked up, on behalf of every component at once — so there is no class to carry an `@rpc` and nobody who could write one. The library declares effects for them itself now, in one table beside the dispatch code. A principal permitted to observe can browse a collection it was already permitted to watch, and resolve the ambient context it was already permitted to be inside.

`$acquire` and `$release` are in that table too, keeping the value the default gave them: taking the lease that says nobody else may command is an operation. Listing them beside the read is what makes it a table of what the library does rather than a list of exceptions.

**A deployment's own declaration still wins**, which is the useful direction — a site whose catalogue is itself sensitive declares `$data` an operation on that component, and nothing here overrides it.

Found from outside, by a bridge that had wired the four refusal levels up and could not explain why an assistant badged to observe could subscribe to a controller's state and not page its symbol table. The mistake worth keeping is not the classification but its silence: nothing logged a surprise, because from every layer's own point of view the system was working.

### A peer announces what it can currently do that is dangerous

The half of a development-access design that comes first, because it is the half that tells you whether the rest is working. Today "is anything on this network unlocked right now" has no answer at all, and a gate whose state nobody can see is a gate nobody can audit.

`describe()` now carries `elevated`, and the console draws it above everything else on the peer — a banner rather than a badge among badges, because an answer somebody has to go looking for is one nobody finds.

**It announces and nothing more.** `authorize()`, the grants document and each capability's own allow-list decide what may happen, and would decide the same with the field removed.

**Asked of the instance rather than remembered by the host**, the way `dataResources()` is: a component that *is* an elevation implements `elevation()`, so composing it into a host is what makes that host announce it. `@source-repo/docker`'s control and create tiers do, so a host that can start containers says so without anybody remembering to say it — which matters, because forgetting is the failure this catches. `server.elevate()` covers what is not an object: a mounted socket, a debug endpoint, a flag.

**The most important field is `until`, and the most important case is its absence.** An elevation nothing will close is the taped-over key — opened for a reason that passed, with nobody coming back. A viewer draws that as worse than a bounded one, and a given `until` is enforced as well as announced so the announcement cannot outlive the thing. A lapsed elevation is not announced: posture is what is true now, and history belongs in the audit trail.


### `@source-repo/docker` — what is running on this host, and nothing that could change it

A plant box with a handful of containers is far commoner than a cluster, and the question asked about one is nearly always the same: what is running, what stopped, and when. This answers that over the network the rest of the site already uses.

**Three tiers, in three namespaces, behind three imports.** `@source-repo/docker` reads; `/control` starts, stops, restarts and removes existing containers behind a name or label allow-list; `/create` makes them behind an image allow-list. Composed rather than subclassed, because two namespaces are two `authorize()` surfaces — an operator can grant reading to everyone and control to nobody, where a subclass would have made "may call docker" one permission.

**The tiers are not the same risk, and treating them as one is where this usually goes wrong.** Restarting a container that already exists escalates nothing: its image, mounts and privileges were chosen by whoever created it. *Creating* one is where a caller chooses those. So the create spec **cannot express an escape** — no binds, no `privileged`, no capabilities, no devices, no host network, no host PID — as a closed shape rather than a deny-list, the same move the filter grammar makes. A deny-list is a list somebody must keep complete; a closed shape is one nobody can add to from outside.

Everything is closed by default: no manage rules means nothing controllable, no image allow-list means nothing creatable, and both refusals say which rather than reporting a daemon error. A rule constraining nothing is refused where it was written, since an empty rule read as "no constraints" is read as "everything".

**How many is state; which ones is a resource.** `running`, `exited` and `total` are bounded facts the contract can name, so they are published and subscribed to. Which containers exist is data that changes as things are started elsewhere, so it is a `dataResources()` collection a caller pages, filters and orders — through the library's own matcher and pager, so `state:exited` means here what it means anywhere. About the smallest honest example of the split the component model draws.

Reachability is a fact rather than an exception: a host without Docker publishes `reachable: false` with a message naming what to check, including the permission half, which is the likelier cause on a machine that does have Docker.

No dependencies — `http.request` takes a `socketPath`, which is all this has ever required. Tests run without a daemon and skip the live half, with `SOURCE_RPC_REQUIRE_DOCKER=1` turning that skip into a failure, the same guard as the MQTT suites.


### A component can be asked for a page, and not only watched

A projection narrows what a subscription pushes, and stops where the question becomes *which* fifty of three hundred — a predicate, an order and a page over data the caller does not hold. `$data(type, resource, params)` answers that, served at dispatch level beside `$acquire`, gated by the same `authorize()`, and free over any record in a component's state: the base class serves it from the contract and the author writes nothing.

Its shape is react-admin's **DataProvider** rather than a query grammar of ours, which is the point — it is the interface several hundred backends already implement, so `getList` today makes `getOne`, `getMany` and the relational verbs the same shape pointed at a second resource rather than features still to be designed. A component with a store of its own implements the same verbs against it.

**Pull rather than push, and that is the decision the rest follows from.** A projection is re-applied per subscriber on every publish, so a predicate living there would make every commit a query on a peer that may be a small computer running a process — and a filtered page is *unstable* under push, because matches depend on values and values change, so one tag going bad enters the match and renumbers every row beneath it with nothing on screen to say so. A call is answered once, when somebody asks, with a deadline on it.

**A filter matching nothing transfers nothing**, which is the property no amount of client-side filtering can have: discovering that nothing matched is exactly what it must receive everything to find out. Filter, then order, then cut the page — a filter applied after paging would be a filter over fifty rows pretending to be one over three hundred.

The filter is a closed grammar and never an expression: `{ field, op, operand }` with `op` one of `startsWith`, `contains`, `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, combined with `all` and `any`, bounded in depth and count. Nothing that runs crosses the wire, deliberately — this is evaluated on the peer holding the plant, and again on every request. `total` is the count of matches, since that is what a pager reads; `pageSize: 0` asks for none of them and answers just that number. Pages are zero-based. A page past the end answers empty with the true total, because the set is data and a page valid when the operator clicked may be past the end when the request lands; a negative or fractional bound, or a page with no `pageSize` to measure it in, is still refused.

`RpcProjectionSlice` keeps its job as the **live window** on a record — it pushes, where this answers — and is now the primitive for a program that wants to watch a range rather than browse one.

### `getMany`, and an order the operator picks

`$data('getMany', resource, { ids })` answers rows a caller already named. Plural from the start, and that is the whole point: a page of fifty rows each naming a customer is fifty lookups, and fifty calls is fifty envelopes and — on MQTT — fifty exchanges. One call for the page is what makes a reference field affordable at all, and resolving a foreign key to a value is the next thing it buys.

Rows come back in the order asked. An id reaching nothing is **absent** rather than null, because "this row is gone" and "this row has no value" are different facts and one of them means a reference is dangling. No `total`, since nothing here is a page. Bounded at 1000 ids, because it arrives from the network.

A component serving its own resources answers through one `dataRequest(method, resource, params)` rather than a method per verb, for the reason `$data` is one verb: `getManyReference` then becomes a value it already switches on rather than a method every implementor has to grow.

The console's grid can now be ordered by the key or by any field the row type declares, ascending or descending. Drawn from the type rather than from a row, so the choices are the same on an empty collection as on a full one — and the order is the peer's, over the whole matched set, because an order applied to the fifty rows already on screen would disagree with itself the moment a page was turned.

### An exposed name can be taken away again

`exposeClassInstance` returns a handle now — purely additive, since it returned `void` — and the handle is the ownership, the same shape `provideContext` already uses.

```typescript
const handle = server.exposeClassInstance(new Job(spec), `job.${id}`)
await handle.withdraw()
```

Withdrawing stops new calls at once, because every dispatch decision starts from the record and a call arriving afterwards finds nothing. It detaches the subscriptions taken out on the name and tells their watchers with a **`$retired`** event carrying the generation that just ended — which exists because retirement otherwise has no frame at all: `removePeer` covers the *subscriber* going, and nothing covered the reverse, so a watcher could not tell a retired instance from a live one that had simply not emitted lately.

Re-exposing the name is a **new incarnation at a bumped generation**, and so is a deliberate `{ replace: true }`. A name is not a thing; it is a place a thing stands, and a client replaying its subscriptions across a reconnect must not silently reattach to a different object wearing the old one.

**A call already queued is answered rather than run.** Withdrawing stops new calls at the door, but one already waiting behind a serialised instance holds a bound handler and would otherwise run into something unreachable. It is refused `OwnershipChanged`, which already means *certainly did not run* — reused rather than joined by a new `Retired` code, because the posture is identical and only the cause differs, so a new code would cost every peer a case to write for a decision it makes the same way. Letting the call die of its deadline instead would have called that an unknown outcome, which is the distinction this library exists to preserve.

**An exposure may be bound to a peer**, off by default and never without a grace window: `{ lifetime: { peer, graceMs } }`. On MQTT `peerGone` is presence and a last will and it flaps, and a reloading browser returns as a fresh peer moments later — retiring on the event itself is how a wifi handover cancels somebody's job.

Nothing expires an instance on a timer otherwise. An object retired out from under an author who still holds a reference is worse than a leak, because it exists and is unreachable.

### Deferred replies: a long job can answer the caller that asked, and nobody else

A caller starts work that outlives any sane call deadline — a report, a scan, a batch import — and the result belongs to the peer that asked. Events broadcast, a per-job instance leaks a namespace for the process lifetime, and a hand-rolled result sink costs a peer and forty lines of bookkeeping. The library absorbs it.

```typescript
@rpc({ semantics: 'non-repeatable-command', injectInvocation: true })
async start(spec: Spec, inv: RpcInvocationHandle): Promise<RpcTicket<JobResult, number>> {
    const reply = inv.defer<JobResult, number>()
    void this.run(spec).then(reply.resolve, reply.reject)
    return reply.ticket
}

const ticket = await jobs.start(spec)
ticket.on('progress', (pct) => setBar(pct))
const result = await ticket.result
```

**The ticket's id is the call's id**, which is the whole trick. The caller is already waiting on that id and registered it before the frame left, so nothing is minted, no extra byte travels, and there is no window where a result names a ticket the caller has not heard of. It also makes the security property structural rather than advisory: **a reply is accepted only for a call this peer actually made, to the peer it made it to.** Hand-rolled, that check is something an author has to know to write and its absence is invisible — everything works in testing and forged results land on an operator's screen. A refused attempt is reported as `ticketRefused` rather than dropped, because silence is not evidence.

A deferred reply travels as a **reply** — a `TICKET` payload carrying the request id — rather than through a namespace of its own. Nothing is exposed, nothing is withdrawn, and it needs neither the registry refactor nor namespace withdrawal.

**A ticket is deliberately not thenable, and that is not a style choice.** A deferred method is reached through an ordinary call, so the caller writes `await jobs.start(spec)` — and `await` unwraps thenables *recursively*. Had a ticket been a `PromiseLike<T>`, that first await would have flattened straight through it to the result, in the types and at runtime, and the handle would never have existed to subscribe to. The progress channel would have been unreachable by construction. So the answer is on `ticket.result`.

**Two deadlines, never conflated.** `$with({ timeoutMs })` bounds the call that started the work; the ticket carries its own expiry, transmitted separately and defaulted an order of magnitude apart, because anyone given one number will set it meaning the other.

**Abandonment, which is not cancellation.** When the waiting peer goes, `reply.on('abandoned')` fires and the handler decides. The library cannot stop a running method, so it does not offer `cancel()` — reporting a fact truthfully is a much smaller promise and one it can keep. The caller's side of the same event rejects its outstanding tickets rather than leaving them to lapse half an hour later.

**These die with the process, and that is the first line rather than a footnote.** `@source-repo/queue` is what durable long work is for — leases, retries, dead letters, survival across a restart. A deferred reply is the lighter thing, and reaching for it where the queue was meant is a difference discovered during a restart.

### A contract can describe a method that answers later

Groundwork for deferred replies, and useful on its own because it is the part that decides whether the feature can be checked at all.

A method returning `RpcTicket<T, P>` used to be **refused** by `extract`, correctly: as a TypeScript value a ticket is an awaitable, subscribable handle, and `on`, `off` and `then` are functions that cannot be checked on the wire. But what actually crosses the wire when such a method is called is a correlation id and an expiry — the payload arrives later, down the reply channel.

So `returns` now describes what the *call* answers, `{ id, expiresAt }`, and the method carries `deferred: { result, progress? }` beside it. A field of the method rather than a new `TypeNode` kind, because a ticket is a property of how a method replies and not a value a field could hold — nothing would ever nest one inside an object, and the type language stays closed.

Compatibility checks the deferred payload covariantly, exactly as it checks a return, so a result type that changes incompatibly is still a breaking change rather than something the contract quietly stopped watching. And a method that moves its result *into* or *out of* a ticket is itself breaking: every type can still line up while a caller waiting on the reply gets a correlation id instead, which is the same shape of change as a query becoming a command.

A ticket that reports nothing carries no `progress`, rather than carrying `any` and claiming to have checked something.

### A name is claimed, not assigned

`exposeClassInstance` overwrote whatever already held a namespace, with no check. `createRpcInstance` is exposed to the network and takes the instance name as a caller-chosen argument, so an authorized peer could create something called `plant` and silently displace the plant — every later call going to it, with nothing at either end saying so. An authorizer *could* inspect the requested name in `params`, but that is every application rebuilding a type system in a callback to close a hole the library left open.

It now throws, naming what holds the name and what to pass if the displacement was meant: `{ replace: true }`. Re-exposing the *same* instance is still fine and re-applies its options, because that displaces nothing.

### A server can hear its own link

`RpcClient` re-emits transport state; `RpcServer` sent `connected`, `disconnected`, `peerGone` and `peerDisplaced` to a private emitter that drives component channels, and stopped there. An application dialling out with `connect` — the shape a browser peer that also serves has — had to reach into `transports[0]` to learn it had reconnected, which is exactly the moment it must reconcile.

The server is an emitter now and re-emits those, plus `peerOnline` and `peerShape`, which the internal wiring never needed and an application often does. Emitted after the internal wiring, so anything reacting to a reconnect sees channels that have already been told rather than a view still marked stale.

### A declared row type can be checked against the rows it describes

Nothing connects a resource's `row` to the values that actually come back. It is written by hand, or built at runtime from a store's own schema, so a renamed column, a SQL type mapped to the wrong `TypeNode`, or an interface changed without its declaration changing with it all produce a grid drawing the wrong columns and saying nothing. A viewer cannot tell, and neither can `check` — the contract describes what a *call* to a resource answers, not what its rows look like.

`validateResults` now checks served rows against the type that claims to describe them, and refuses the answer naming the resource and the row when they disagree. Off by default, like the return check beside it: a host checking its own output, worth every millisecond in development and per-row work nobody should pay for in a plant.

Only for declared resources. A record in a component's own state is already described by the published contract and covered by snapshot validation, so checking it here would ask the same question twice.

### A row of a resource can be acted on

A viewer could browse a collection it had never heard of and do nothing to it. An editor resolves from `sets`, and a row of a store-backed resource has no state path for any method to claim — so the console could page, filter and order a queue's dead letters and not retry one, while `retryDeadLetter` and `discardDeadLetter` sat there declared, authorized and unreachable.

A resource may now say which of the component's own methods apply to a row. That adds no capability: each is an ordinary `@rpc` method that already existed, and the declaration carries the one fact a viewer cannot work out — which method is about which row, exactly as `sets` does for a field. A value is still never written; a method is still called.

The id is the only argument. `confirm` is the author's judgement about its own method rather than a console's guess from the name. And a viewer checks the method exists before drawing anything for it, because a typo in a declaration would otherwise produce a control that fails only when somebody tries it on a plant.

`@source-repo/queue` declares both of its dead-letter actions, which is what proved it.

### And which half of it was slow

`queryMs` and `countMs` beside the total, for a component that can tell the two apart. They are one number for a record held in memory — filtering produces the matched set and `total` is its length, so the count is a byproduct that costs nothing. They are two very different numbers over a real table, where `LIMIT 50` comes off an index and `COUNT(*)` over the same predicate walks it, and the second is routinely most of the time.

Reported rather than inferred, because the difference decides what to do: a slow page wants an index, and a fast page behind a slow count wants the count asked for less often, or estimated, or not at all. One figure says "slow" and leaves the reason to guessing. `slowRequest` carries the same breakdown, so the peer names which half held it up.

The console shows it as `peer 320 ms (rows 5, count 300)`.

### A slow answer stops looking like a dead link

Development is where this bites: something is not well designed yet, a pane sits there for a minute, and nothing anywhere says why. Two numbers and one event fix most of it.

Every `$data` answer now carries **`ms`, how long the peer spent**, filled in by the dispatcher so it is there whoever served the resource and no implementor has to remember it. The console shows it beside the rows, and shows **how long it has been waiting** while a fetch is in flight. Their difference is the link; without the second number a slow query and a dead link are the same thing from a browser.

The peer reports the half a console cannot see. **`slowRequest`** fires on the server when a request takes long enough to have held it up, naming the resource, the time, and whether the component or the library answered. That matters because the library-served path filters and sorts **synchronously**: a large enough collection holds the event loop and everything that peer does stops, snapshots included, and from outside that is indistinguishable from a peer that has gone.

An error in the grid names the resource it was asking about rather than only what went wrong.

### `getManyReference`, which is one-to-many and almost no code

The rows of one resource that point at one row of another: the orders of this customer, the readings of this tag. Served as `getList` with the reference and-ed onto whatever filter the caller sent, rather than as a second implementation — so paging, ordering, the count of matches and the treatment of a page past the end are identical by construction rather than by having been written twice the same way. `total` is the count of referencing rows, which is what a pager under a record needs, and a caller's own filter narrows further rather than replacing the reference.

That is the claim the DataProvider shape was taken for, and it costs four lines: one-to-many is not a new mechanism, it is a list with the join already in hand.

`getOne` stays unserved and probably always will: a caller wanting one row asks `getMany` for one id, and a verb existing only to be a worse version of another is not worth the wire.

### The queue serves its dead letters, and finds two things out

`@source-repo/queue` is the first component to implement `dataResources()`, so the DataProvider stops being proved only against a record held in memory. Its dead-letter backlog is now a resource a viewer can page, filter and order — the state's counts say how many failed, and this says which.

**An offset page over a cursor store is a walk.** The queue's store lists dead letters by `after`, so there is no way to begin at row 200 without having seen the 200 before it; the service reads the backlog and answers from it, which is affordable because retry policy bounds that backlog and it is meant to be drained rather than accumulated. A store where that is not true should page itself. Worth knowing before a component over a real table is written — and worth `$data` growing a cursor for eventually, which `ra-tree`'s own listing shape already argues for.

**Filtering on the peer is a claim about the wire, not about the store.** Only matches cross the link, which is what the pull is for, but the read behind them was unfiltered here. A component over a database should push the predicate down; one over a bounded in-memory backlog is right not to.

Two smaller ones: the row type has to be **written out by hand**, because a resource is named at runtime and nothing connects it to the TypeScript interface the extractor could otherwise describe — a real cost of the interface rather than an oversight. And a store-backed component stamps its answers from its own component snapshot, so a restart stays visible to a caller paging through.

`pageEntries` is exported for this: a component that fetched rows from somewhere else filters, orders and pages them through the library's own code rather than reimplementing it, for the same reason `matchesFilter` is shared. A `getList` that meant something slightly different depending on which component answered it would be worse than one that was missing.

### A component may serve collections its contract cannot describe

A record in `props` or `state` needs nothing declared: it is in the published type, so a viewer finds it by reading the contract. A table, a document collection or a queue is the other kind — **what resources exist is itself data**, discovered when the component connects to its store, so it cannot be extracted from source and has to be said at runtime.

A component implementing `dataResources()` and `dataList()` publishes what it serves — the path, the shape of a row, the verbs each answers — and `describe()` carries it under the component. Structure and never a row, like everything else `describe()` says. A viewer that has never heard of the component draws its columns from that alone, which is the same claim the panel already makes about ovens, one level up: the contract knows a component *serves* collections, and only the component knows which.

Both methods are required together, because a component listing resources it cannot answer for would publish a table that renders as a permanent error, and one answering for resources it never listed could not be found. A declared path is answered by the component and anything else falls through to the record rule, so serving a store does not cost a component access to its own state. Resources are read at describe time rather than fixed at exposure, so a store that gains a table says so on the next describe rather than at the next restart.

In the console a declared resource is a root of the scope tree beside `props` and `state`, and reads as a record of its row type — so the grid pages it with no special case at all. Only resources answering `getList` are offered, since that is the only thing the grid can do with one.

### The console draws scope and values as two panes

One tree of everything is right for an oven and wrong for anything carrying hundreds of values, which plants have. The component panel is now a scope tree on the left and a flat grid on the right, and selecting a node narrows the grid to everything beneath it recursively, so the tree filters rather than navigates.

**A record is a value leaf and never a tree node**: `tags: { [tag: string]: Reading }` is not in the tree at all, its entries are rows. That is principled rather than a size threshold — an object's members are named by the contract and a record's keys are data — and it is what makes the scope tree exactly the contract, drawn before a single value arrives and costing nothing on the wire however much data sits behind it.

The same line decides how the grid is fed. Typed leaves are **subscribed** to, since the contract bounds how many there are, and this is the first thing in the repository to ask for a projection — the open end `4.5.0` left. Collection rows are **asked for** a page at a time. A panel pulling fifty rows while its subscription pushed all three hundred would look exactly like the feature working, so it never takes the whole snapshot.

One filter box serves the pane, and both halves answer it: the subscribed fields are filtered where they are already held, and the collections carry the same condition to the peer, so a search matching nothing there costs a sentence rather than a record. A bare word matches the path, `field:word` narrows to a field, `&` and `|` combine — so `setp` finds a setpoint two levels down and `quality:bad` is answerable at all. Both ends call the library's own matcher rather than each having a version of it, because a search meaning two different things either side of one pane would be worse than no search at all. Pages are polled at a period the operator sets, down to manual, because a subscription's rate belongs to the component and on a 1200 bit/s link a 50-row page is already seventeen seconds. The next fetch is scheduled when the previous settles rather than on a timer, nothing is asked while the tab is hidden, the last answer stays readable while a fetch is in flight, and a page refetches at once when a call settles.

### A projection slice taking nothing is a count

`{ path: ['state','tags'], limit: 0 }` takes no entries and still reports `total`, so a caller learns how many pages a record has for one number rather than for the record. That always fell out of the arithmetic; it is now stated and tested rather than left as something that happens to work, because a caller relying on it should not have to discover it by trying. `$data`'s `pageSize: 0` answers the same question the same way, and the two agreeing is the point.

The record is absent from such a snapshot rather than present and empty, which is the more honest of the two: `{}` would say it holds nothing, where the slice beside it says it holds three hundred and that none were asked for.

### Calls issued together travel in one frame

A `POST` carries its type, a uuid, the namespace, the method name and the params, and MQTT adds a request topic, a response topic and correlation data beneath it — so moving one `float64` spends far more on saying where it is going than on the number, and reading three hundred tags one at a time is tens of kilobytes of envelope for a couple of kilobytes of values. Calls issued in one microtask now go as a single `BATCH` frame.

**On by default**, which is the point: batching that has to be discovered is batching most code never gets. `batchCalls: false` on `RpcClient` or `RpcServer` is the escape hatch, and the only reason to reach for it is a peer built before this version, which cannot unpack a `BATCH`. There is no negotiation, so that has to be said rather than detected. Servers from this version understand `BATCH` whether or not they send one, so only an old *server* needs a caller told.

It saves bytes rather than round trips, and the two are worth keeping apart: calls issued concurrently are already pipelined, so twenty cost one round trip whether or not they share a frame — what they did not share was twenty envelopes. On MQTT it saves exchanges as well, each publish carrying its own topics and its own acknowledgement. It cannot help a caller that awaits in a loop, because the second call is not issued until the first has answered; that is what plural methods like `rpcWrites` and a projection's path list are for.

**Bounded at both ends, because a peer may be a very small computer.** A frame is decoded whole before any of it dispatches, so an unbounded batch is an unbounded buffer on the receiver, and the mailbox bound does not help — that limits a queue, by which point the frame is already held. The sender splits beyond `maxBatchCalls` (64); a receiver refuses more than `maxIncomingBatchCalls` (256) and answers every call in the frame `InvalidParams` rather than dropping them, since a sender's own bound is not protection. The default costs little: N calls save N−1 envelopes out of N, so sixteen captures 94% of the maximum possible saving and sixty-four captures 98%.

**A batch is an envelope and never a transaction.** The receiver unpacks it and feeds every payload through the ordinary dispatch, which is what keeps idempotency, semantics, `authorize()`, the owner fence and the deadline working per call — one failing settles one call, and nothing is shared but the frame. A batch nested inside a batch is refused rather than unpacked.

### The AI grants document: closed by default, on every node

What an AI principal may do here is now a small declarative document rather than something an authorizer has to be written to express — because a console can render data and cannot render a callback, and a reviewer can diff a file and cannot diff a decision made inside somebody's `authorize`.

`aiGrants` on `RpcServer` takes a schema-versioned document carrying a monotonic revision and the grants that are open: `ai.tool.write`, `ai.tool.program`, `ai.program.write`, `ai.program.program`, and `ai.sponsor` for `security-admin`-effect calls. Each may be scoped `to` peer names or `roles`, given an `expiresAt` lease, and bounded by `maxGeneration` so a grant can say how far down a chain of programs it reaches.

The properties that matter: **closed is the default everywhere** — a node with no document refuses every AI write and programming call, and there is nothing to switch on to be safe; **enforcement runs before `authorize`**, so a node whose author wrote no authorizer still refuses, with `authorize` remaining the fine-grained veto above it; **observation stays open**, because a badged principal that can see everything and touch nothing is useful on day one; **one grant never covers another**, which is what `effect` was added for; and **a malformed document refuses the server** rather than being read as granting nothing. `onAiDecision` receives every gated decision with the sentence explaining it — the open half of the audit story.

Behaviour note for anyone who adopted 4.6.0's derived credentials: scripts carry `ai-program`, so their state-changing calls are refused until a grant opens that rung. That is the intended shape rather than a regression, and observation is unaffected.

### A tap ends with the page that opened it

A console tap was released only by `untap` or its five-minute ttl, so every page that closed left one running — and a debugging session is mostly reloads. A tap now records the peer that opened it, taken from the invocation handle rather than a parameter, since a caller-supplied name would be a claim and what this decides is whose tap to stop. A page is a peer on the console's own listener, so a closed tab takes its tap with it. The ttl stays as the backstop for an opener that left without a goodbye, and `taps()` now reports the owner — which answers *who is tapping what* rather than only what is being tapped.

`injectInvocation` could not be used on a method whose last real parameter is optional, which `tap(filter?)` is. TypeScript refuses a required parameter after an optional one, and both the extractor and `WithoutInvocation` demanded exactly `RpcInvocationHandle` rather than the `| undefined` that an optional declaration produces. Both now admit the optional form, and neither admits a trailing `unknown` — the trap the bidirectional check exists for, since `unknown` accepts a handle without being one and stripping it would silently shorten an honest signature. `NonNullable<unknown>` is `{}`, which is not a handle, so that stays true. There is a type-level test, because a regression here does not throw: it publishes a handle in somebody's proxy signature.

The wire contract is unchanged — the handle never reaches callers — and `ConsoleTap` gains `owner`.

### The grants document, reachable from the command line

`aiGrants` was enforced by the library and offered by nothing the CLI had, so `source-rpc node` — the command whose entire purpose is running scripts, and whose scripts carry `ai-program` — had no way to be given one. `node` and `mcp` now take `--grants <file>`, and a `node` task takes `grants` as a path.

A path rather than flags, because the document is data with a revision: a console can render it and a reviewer can diff it, which is why it is a document and not somebody's `authorize`. It is also not a secret, so unlike `sign` and `auth` it is never written inline in a task file — the revision exists so policy can be replaced on its own cadence.

A document that cannot be read refuses the node rather than starting with nothing granted. Startup prints what is open whether or not one was given, since closed-by-default means "it is running" and "it can do something" are separately true. Refusals are printed as they happen, with the sentence explaining them; permitted calls are not, because burying a refusal is the way to make it useless.

`SIGHUP` re-reads the document on `node`, on `mcp` and on every node a task file started, so a grant can be closed without stopping a node in the middle of something. A failed reload keeps the document already in force; a revision that goes backwards is applied and said out loud.

### One host process from a task file

`source-rpc run host.tasks.json` starts console, node and contract-backed serve roles in one process. Shared network settings remove the repeated broker URL while every task keeps a distinct peer name and signing file, so combining supervision does not combine authority. Paths are relative to the task file, unknown fields and duplicate identities are refused before startup, a later failure closes roles that already started, and SIGINT/SIGTERM closes them in reverse order.

Console startup now reports listener errors such as `EADDRINUSE` to its caller and closes the network connection it had already opened. Previously that error escaped as an uncaught server event, which made reliable multi-role rollback impossible and left an announced peer behind after the listener failed.

### Credentials a task file can carry, and a generated one to start from

`sign` and `auth` each take a path or the secrets themselves, so a host whose roles are deployed as one unit can keep one file instead of four. `sign` inline is the peer's own HMAC identity and the `peers` it verifies; `auth` inline is the `token` a hub is shown and the `derive` secret a node mints its scripts' credentials with. `tokens` and `issuers` are refused inline, because they say what a bus accepts and no task type is a bus — an `auth` file may still carry them, since that file is what `broker` reads. `network.mqtt` gives the broker account a place in the file, replacing `SOURCE_RPC_MQTT_USERNAME` and `SOURCE_RPC_MQTT_PASSWORD` rather than merging with them, so half a credential can never come from each. A task file that carries secrets gets the mode warning key files have always had.

Two things a task file could not do before this, both of which looked configured and were not: a node started from one now mints derived credentials for its scripts, where previously `derive` had nowhere to go and every script started unauthenticated; and a task can present a bearer token to a hub that authenticates, where previously there was no way to give it one.

`source-rpc run --init host.tasks.json` writes a task file with the three roles, fresh signing secrets from the system generator, each role's `peers` naming the others, and `--scriptable-by` in all of them. Mode `600`, and it refuses to overwrite — the file it would replace holds the identities every other machine on the network was told to expect.

With no file named, `run` and `run --init` both use `source-rpc.tasks.json` in the working directory — so a set-up host is `source-rpc run` and nothing else. The working directory and nowhere else: this does not walk up the tree the way `package.json` is found, because a task file is an identity and which one ran must not depend on where the shell happened to be. The filename is defaulted and the command is not; bare `source-rpc` still prints usage, and now mentions a task file when it sees one rather than starting it.

A `console` task also takes `cert` and `key` now, so a host already serving an HTTPS console can move to a task file without quietly becoming plain HTTP — which it would have, since a file that says nothing about certificates is a valid file. Both together or neither, and a certificate moves the default port to 8844 exactly as `--cert` does.

## Source RPC 4.6.0

Two pieces of the AI boundary's foundation, both prerequisites rather than the boundary itself, and one behaviour change worth reading before upgrading a node that runs scripts.

### Derived credentials: a script gets one of its own

A node that runs scripts used to hand each one its own bearer token. That was wrong twice: a token is pinned to exactly one peer name, so the script could not authenticate under its own name with it anyway — and passing it put the node's credential into the environment of an arbitrary program, which for a program an AI wrote is precisely what the boundary work exists to prevent. **The node's token no longer reaches a script at all.**

`mintDerivedCredential` and `createDerivedAuthenticator` are the mechanism: an issuer holds a secret the bus also knows, mints a short-lived signed credential naming the child, and the bus verifies it without having been configured with anything about that child in advance — which is the point, since a node may start a script the operator has never heard of. What a bus is configured with is which nodes it lets vouch for their children. `firstAuthenticator` composes it with `createTokenAuthenticator`, so operators hold tokens and nodes vouch for programs on the same bus.

In the CLI: `derive` in a node's auth file, `issuers` in the bus's. A script is started with `SOURCE_RPC_NAME` and `SOURCE_RPC_TOKEN`, its identity carries `ai-program` in roles and the issuer, generation and chain in claims — visible to `authorize` and the invocation handle at every dispatch. Without `derive` a script starts with no credential rather than borrowing the node's, which on an authenticating bus means it reaches only what an unauthenticated peer may reach. Honest, and the previous behaviour was not.

Lifetimes are short and there is no renewal, so a stopped node's credentials expire on their own; immediate revocation is separate work and does not exist yet. HMAC is symmetric — whoever can verify one of these can mint one — so the secret is shared only between a bus and the nodes it trusts to speak for their children.

### `effect`: what kind of power a method exercises

Declared beside `semantics` and deliberately orthogonal to it, because the two answer different questions and one field cannot carry both: `deployProgram(bundle)` and `setSetpoint(value)` can be equally honest `idempotent-command`s, and permission to move a setpoint is not permission to deploy a program. `@rpc({ semantics, effect })` takes `observe`, `operate`, `program` or `security-admin`; `exposeMethods` takes it too, so code that cannot use decorators is not locked out.

Undeclared defaults conservatively — a declared `query` observes, anything else operates — because an unclassified method is not a harmless one. `describe()` always reports an effect so a consumer never reimplements that rule; `extract` records only what the source declared, and a mistyped effect is a loud diagnostic rather than a silent omission, since this is the field a future grant is written against. `check` treats an escalation as breaking and a dropped declaration as breaking, while *adopting* a declaration where there was none is deliberately not flagged: saying out loud what a method always did must never be the change that fails a build.

Nothing enforces this against AI principals yet — that is the AI boundary work, and this classification is its prerequisite. It lands first because contracts are long-lived and the field is cheapest to add while the only contracts in the world are ours.

## Source RPC 4.5.0

One thing, both halves: code that cannot use decorators can now say everything the decorators say.

### Decorator-free marking that can say everything, and a CLI that strips

`@rpc` and `@rpcNamespace` are standard ECMAScript decorators, V8 does not ship decorators, and Node's type stripping — how the scripts directory runs — dies on the `@` with a SyntaxError. The population that cannot compile was locked out of exactly the options the field trial proved scripts need most. Two answers, one mechanism:

`exposeMethods` now takes an object form carrying the same options the decorator takes — `exposeMethods(ChatService, { say: { injectInvocation: true }, status: { semantics: 'query' } })` — and `declareRpcNamespace(ChatService, 'chat', { version })` is the decorator-free `@rpcNamespace`. Both write the records the decorators write, so semantics, conflation, authority and the invocation handle are no longer privileges of code with a build step. The array form of `exposeMethods` stays as the nothing-declared shorthand.

`source-rpc strip <file…> --out <dir>` writes the decorator-free twin of a decorated source file: decorators blanked in place, the marks re-said as those runtime calls on each class's closing-brace line, line numbers unchanged so stack traces read against the source. Only the library's decorators are understood — anything else is refused, never guessed at — and the output refuses to overwrite the input, because the decorated source stays the one you edit and the one `extract` reads. The MCP server now teaches this in its instructions and in `save_script`, so a model writing a script learns the rule before hitting the SyntaxError instead of after.

## Source RPC 4.4.0

The first fruits of the first field trial: an agent that had never seen the system used it for an afternoon (`notes/session-feedback-2026-08-01.md`), and what it stumbled on became issues. This release is their fixes — one behaviour change (the broker's bind, below), everything else additive.

### The invocation handle: who is actually calling

A method that opts in with `@rpc({ injectInvocation: true })` receives a branded `RpcInvocationHandle` as its final parameter: the routed `source`, the transport-vouched `identity` when there is one, the request id, the caller's `ttl` and its idempotency key. The parameter never exists for callers — the proxy type strips it and `extract` omits it from the wire schema, diagnosing both half-declared states — and absent optional arguments cannot shift it out of its seat. The console's chat is the first consumer: a message now files under who actually called, and the field trial's spoof (`say('page-…', …)` from a CLI) lands under the CLI's own name, with `from` surviving only as display data. Explicit rather than ambient by design: no AsyncLocalStorage, so a browser page hosting services behaves exactly like Node.

### The broker binds loopback until told otherwise

**Behaviour change.** `source-rpc broker` now binds `127.0.0.1` by default, the same instinct as the console, and states on startup which of the two surprises applies: a bare broker that the next bench cannot reach, or a `--host 0.0.0.0` one the whole segment can. It bound every interface silently before; a deployment that relied on that passes `--host 0.0.0.0` now — the container image and `docker-compose/network.yml` already do, since inside a container the `-p` mapping is what decides reachability. The library's `HttpServerOptions` gains the `host` field that makes the bind expressible at all; absent, a service binds wide as it always has.

### `peersSettled()`: presence-settled ready

`ready()` means the link is up, not that presence has arrived, so asking who is there immediately found an empty network on a bus that was plainly there — and every script re-wrote the same poll-for-peers loop. `await peer.peersSettled()` on both `RpcClient` and `RpcServer` resolves when the first presence sweep has landed — the retained burst read on MQTT (ended by a quiet gap after the subscription is acknowledged, since MQTT has no "that was everyone" packet), the announced list delivered on socket.io — and returns the names known at that moment. Settled means the first picture arrived, not that every peer that will ever exist has; the bounded wait resolves rather than throws. `source-rpc peers` and `source-rpc find` now use it in place of a flat one-second sleep, so a settled network answers in tens of milliseconds.

### A description hash in presence, so caches notice a peer changed shape

The console caches what a describe taught until the peer is reselected, and the MCP holds a thirty-second describe cache — so a peer restarting under the same name with new namespaces showed its old shape, which bites an agent that describes once and acts on the answer for minutes. Presence now carries a short hash of each server's described surface: over socket.io in announcements and hub snapshots, over MQTT 5 as a user property beside the retained `online` payload old peers never look at (on 3.1.1 it does not travel). The hash covers what a cached description answers questions about and deliberately not what moves on its own — subscriber counts and topology epochs shift while the surface stands still. A change is `TransportEvent.peerShape`, emitted only on change; `peers.shapeOf(name)` reads the latest. The bargain stands: nothing describes on sight — the console and MCP drop their caches and re-describe *when next asked*, the console's open panel refreshes itself instead of waiting for a reselection, and an unchanged peer costs no extra describes. Exposing something after `ready()` re-announces, so surfaces that grow in place invalidate too.

### Event cursors: "saw nothing" can now mean "missed nothing"

A server keeps an emission counter per `(namespace, event)` — from expose time for declared events, whether or not anyone is subscribed — and each delivery is stamped with its `seq` and the server's `epoch` (the component channel's discipline applied server-wide: a sequence only orders within one incarnation). `msgrpc.eventCursor(namespace, event)` reads the counter, behind the same introspection opt-in and `authorize()` gate as `describe()`. The MCP's `watch_events` uses it to report `loss` per watched stream: gapless, missed N, **unknowable** when the server restarted between watches (a fresh incarnation cannot say what an old one dropped, and does not guess), or unable-to-say for a peer that predates cursors. Additive on the event payload and the introspection contract; peers that never ask notice nothing.

### MCP: a second door — streamable HTTP on localhost

stdio means exactly one client, and the field trial lived the consequence: a node attached to another session, and the second agent's fallback forked the scripts state the node was custodian of. `source-rpc mcp --port <n>` now serves streamable HTTP beside stdio — one POST, one JSON-RPC message, one JSON answer, no SDK — and every client shares one view of the scripts, fakes, watches and loss cursors, because there is only one of everything in the process. The bind is the console's instinct (`127.0.0.1`, `--host` to widen with the warning naming what that means), and access control was designed before the port opened: the bearer token comes from `SOURCE_RPC_MCP_TOKEN` or `--mcp-auth <file>` (never a flag value), a widened door without a token refuses to start, and a loopback door without one says plainly that any process on this machine can drive the node.

### `@source-repo/queue` 0.2.2

No behaviour change. `QueuePeer` is loosened to `Promise<unknown>` with casts at the queue's own boundary, so it stops chasing the library's per-release proxy type - which this release's `RemoteSurface` stripping would otherwise have forced on it.

### Small things

`source-rpc --version` prints the version; there was previously no way to ask. The MCP server's `serverInfo.version` now comes from the manifest too - a hardcoded copy had sat at 3.0.0 for two majors.

`mcp` and `node` print one line at start when the scripts directory's `@source-repo/rpc` major differs from the CLI's, naming both versions — the field trial ran an afternoon against a two-majors-old sandbox and nothing noticed. A statement, never a refusal: old scripts against their own pinned library are legitimate. What is installed outranks what is declared.

## Source RPC 4.3.1

No code changes in any package. The documentation moved to **[source-repo.github.io/rpc](https://source-repo.github.io/rpc/)** — the full guide with an always-visible sidebar and search, including four chapters nothing had documented before: observable components, command authority, topology, and structural context. The READMEs npm shows are now the short form — the pitch, install, one example, and the feature list with links into the site — which is this release's reason to exist.

## Source RPC 4.3.0

The final milestone of the adopted architecture: **structural context** — inherited, cached, versioned ambient data, resolved through exactly one declared topology axis. Everything is additive over 4.2.0.

### Structural context

`defineRpcContext` declares a token: a namespaced id, a schema version, exactly one axis (`physical` or `logical` — there is no logical-then-physical search, by design), `nearest` or `collect` resolution, a stale policy, a capture policy, and an exposure. A host provides at most one value per token per topology node through `server.provideContext()`, owned by a handle nothing remote can reach; a restarted provider is a new provider epoch. `server.contextOf(node, token)` returns a live store — the same `getSnapshot()`/`subscribe()` shape the component channel proved against React — and `requireContext()` is the policy gate that fails closed.

Resolution crosses hosts the way the topology does: the physical chain root to root, the logical chain through remote owners, one register-then-snapshot subscription per upstream host with full frames only, token sets widened by re-subscribing, and reconnects replayed with retry. Twenty tokens inherited over one host cost one subscription. The public lifecycle is `initializing | live | stale | missing | invalid | closed` with a `transitionReason`: a lost providing host is `stale` with the last value kept and its age on it; an owner reassignment is an **atomic remount** — a new mount epoch, never a mixture, the old world only as `previous`, which `require()` never returns; and a cross-host owner ring is caught before the resolver would subscribe its way around it forever, reported `invalid` with the ring's path named.

The `$context` protocol is served at the dispatch level, and its authorization is the design: every `read` and `subscribe` passes `authorize()` with the node and every token id visible, there is no enumeration surface, and a value whose token declares `exposure: 'local'` is filtered from remote answers *silently* — a refusal would confirm the secret exists. `captureRpcContext` packages what a node currently sees for a payload: explicit-capture tokens only, local values never, the aggregate bounded before anything accepts it.

### `@source-repo/queue` 0.2.0

The `latest` queued-context mode is real: a consumer resolves the named tokens against the source host's `$context` when execution starts — the task runs under the world as it is, not as it was — and hands them to the handler as `context.resolvedContext`. An unresolvable `latest` fails the delivery through the ordinary retry-then-dead-letter path with the reason on the dead letter, never running the handler context-blind. The wire type gains an optional `node` on the `latest` variant (default `$host`). Requires a 4.3.0 server for the `$context` surface; against older servers, `latest` tasks dead-letter honestly.

## Source RPC 4.2.0

The release that ships the adopted architecture: observable components, command authority, the federated topology core, capability discovery — and the first tool node, `@source-repo/queue`, published for the first time. Everything is additive over 4.0.0 with one event-payload change noted below.

### Observable components

A long-lived instance can extend `RpcComponent<Props, State>`: cached `props` and `state` snapshots ride epoch/revision ordering with a race-free targeted snapshot on subscribe, and `client.component()` (and `server.component()` — a page that hosts a service observes over the same link) resolves to a typed proxy whose reads are synchronous from a local cache. The store beneath it — `getSnapshot()`/`subscribe()` — is exactly what React's `useSyncExternalStore` consumes, with a per-channel status of `initializing | live | stale | closed`: a dropped link marks the picture stale and keeps it readable with its age on it, and a reconnect repairs it with one snapshot. Component shapes travel in the schema (`extract` resolves them through the base-type chain), the compatibility checker treats them as output, and `describe()` reports structure and a live observer count, never the values. `validateComponentSnapshots` checks each commit against the contract before it becomes current.

### Command authority and the owner fence

`$acquire`/`$release` bring the plant's arbitration concept to any component — granted, visible in every snapshot as `authority`, and always expiring, with `authorityChanged` saying why. Only methods declaring `requiresAuthority` are ever gated, which is the safety rule stated positively: an E-stop never declares it and is therefore provably never behind a held lease. Refusals are `NotInControl`, naming the holder, checked at the door and again after any queue wait. Above it sits the topology fence: `$with({ ownerEpoch })` carries the caller's observed owner generation, and a target whose durable record moved answers `OwnershipChanged` — certainly not run, never blindly retried.

### The topology core, federated

Every host now answers for its own components' `parent` (physical) and `owner` (logical) edges: records with per-link epochs under compare-and-set, a synthetic durable `$host` root carrying the deployment's declared `place`, and the one permitted cross-host physical edge, root to root. Local physical invariants are refused at commit; owner cycles — which no host can police alone — are detected at derivation as invalid topology with the path named. Epochs are durable where the store is (`JsonFileTopologyStore` writes whole and renames; restart never rotates an epoch), and the volatile default says so through the capabilities record `describe()` now serves. Remote mutation is opt-in (`topology.allowRemoteMutation`) and still passes `authorize()`; ids refuse control characters at the boundary. Labels are free Unicode — exactly what the drawings say — and display only.

### Capability discovery

`class Compiler implements UiBuilder` becomes `@scope/contracts/UiBuilder` in the extracted schema — qualified by the package that declares the interface, with the `extends` closure flattened in, so a search for the parent finds the child's implementor as a flat string match. An interface from the class's own package is a loud diagnostic, never a bare name. `describe()` serves capabilities from the schema — a bundled class named `m` still advertises correctly — and `source-rpc find <capability>` plus the MCP `find_capability` tool answer with who implements what. A capability nobody implements is an empty list, not an error, and the MCP's discovery cache validates `call_method` arguments locally: a wrong shape fails `InvalidParams` before spending a network hop.

### The console

The peer list is a tree over what descriptions have taught — hosts attached root-to-root nest, with the declared place beside each name — and the selected peer shows its structure panel with both axes, labels beside ids, and cross-peer owners as links. Observable components render live: status badge, values with per-value quality (`forced` deliberately distinct from `stale`), last-known data dimmed but readable while stale. Write dialogs grade by the contract: a `non-repeatable-command` arms and confirms in the console's own chrome, and the repeat button exists only where the contract says repeating is free.

### `@source-repo/queue` 0.1.0 — the first tool node

Published for the first time: a lease-based work queue over Source RPC — at-least-once stated plainly, acquire-ID replay for uncertain outcomes, lease tokens fencing stale completions, reject-new-only capacity with `QueueFullError`, retries into dead letters with a paged, authorized admin surface, and metrics riding an observable component. One conformance suite over in-process, socket.io and MQTT 5. Its own package with its own version, deliberately outside the versions-together rule, and the release workflow now publishes it whenever its version is new.

### Changed

- **`resubscribeFailed` carries identities, not a count.** The event's payload is now `FailedResubscription[]` — peer, namespace, event and the error for each subscription a reconnect could not restore — because a shadow cannot mark the right values stale from a number. Anything listening to this event reads the array instead.

### Also

- Per-call timeouts: `$with({ timeoutMs })`, with `0` honestly meaning no timer and no ttl — the zero-timeout next-tick bug is fixed.
- A client's event subscriptions are reference-counted, so one handler leaving no longer unsubscribes the rest; peer lifecycle events (`peerOnline`, `peerGone`, `peerDisplaced`) forward through `RpcClient`.
- socket.io clients retry after `io server disconnect`, so a restarted server's peers come back without help.
- `RpcServer.close()` awaits its own construction, closing a race that could leak a listener.
- Graded execution defaults: declared commands serialise per instance, queries run parallel, with a bounded mailbox answering `Busy` and setpoint-shaped commands able to `conflate` into `Superseded`.
- One exported `SCHEMA_VERSION` and a written compatibility policy (`docs/schema-compatibility.md`): what is additive, what forces a bump, what a consumer may assume.

## Source RPC 4.0.0

**`proxy()` returns the remote instance.** It used to return a record — `{ name, target?, remote }` — so every call read `proxy.remote!.method()`. The wrapper carried two fields nothing in the library, the CLI or the console ever read, and a `remote` that was typed optional but could not be absent. What that cost was a word in front of every method and an assertion at every one of 142 call sites, to describe a record halfway through being assembled rather than the one handed back.

```typescript
const calculator = await client.proxy<Calculator>('calculator')
await calculator.square(3)          // was calculator.remote!.square(3)
```

Every call site changes, which is the whole of the break. `$with` is unaffected — `pump.$with({ idempotencyKey }).dispense()` reads as it did, one word shorter.

### `then` is now a reserved name

A remote class could never expose `$with`. It can no longer expose `then` either, and the reason is worth stating because it is inherent rather than a shortcut: `proxy()` is async, so `await` probes what it returns for `then`. The proxy's trap answers every property with a caller for a remote method of that name, so it answered one for `then`, the runtime concluded it had a thenable and adopted it, and the await waited forever for a call nothing would ever answer.

The trap returns `undefined` for `then`. The old wrapper hid this by accident, being a plain object whose `.remote` was only touched after the await had settled — 214 tests hung the moment it was removed, every one of them presenting as a network timeout rather than as a language rule. There is a test on it now, because the next person to touch the trap would reintroduce a hang that does not look like a bug in the trap.

### Migrating

Delete `.remote` from every call. `.remote!.` and `.remote?.` become `.`; a bare `.remote` used as a value goes entirely. Nothing read `name` or `target`, but if you did, they are no longer there — `proxy()` was given both, so the caller already knows them.

## Source RPC 3.4.3

**Nothing in either package has changed.** Both exclude tests from what they publish, and the two commits since 3.4.2 are a test and two workflow files, so the tarballs are the same code 3.4.2 shipped. The release is worth making for the image, which floats on `node:24-alpine` and runs `apk upgrade`, so rebuilding is how it picks up whatever has been fixed in the base since — the case the scheduled scan exists to notice.

### Also

- **A test waited on the wrong party.** The discovery test that calls between two servers waited for the hub to hold a socket for the callee before calling it. That says the callee has connected; it says nothing about whether the announcement has reached the caller, which is what decides whether the call can be routed — and the second call, made the other way, waited for nothing at all. Fast enough to pass everywhere until a loaded Windows runner lost the race and failed with `no route to …`, which is the switch refusing rather than silently dropping. Each caller now waits on its own registry.
- **The workflow actions are off the deprecated Node 20 runtime.** `checkout` and `setup-node` to v7; `build-push-action` to v7 and `login`, `setup-buildx` and `setup-qemu` to v4. Every one of those majors is the same change underneath — Node 24 as the default runtime, and a move to ESM. `trivy-action` stays pinned where it was.

## Source RPC 3.4.2

### Fixed

- **A chat message arriving at the console changed nothing on screen.** The call succeeded and the page answered `delivered` — `ChatService` ran and the message went into state — but the log is keyed by the peer selected in the sidebar and chat is one tab of five, so it was only ever visible to someone who already had that exact peer selected with that exact tab open. Traffic and problems have carried a count since they were written; chat had none, which left it the one pane whose arrivals passed in silence, and the only one of the three another peer can provoke deliberately. There is now a count on the chat tab for the total and a count beside the peer that sent it, since the tab says something is waiting and only the sidebar can say whose. Both clear when you look at that peer's chat, including when the message lands while it is already open.

## Source RPC 3.4.1

Five faults, all of them found from one command line that should not have started: `source-rpc mcp --hub http://localhost:7843 --scripts --contracts`.

### Fixed

- **A flag would take the next flag as its value.** That command is two flags with no directory between them, and the word after a flag was read unchecked — so `--scripts` took the literal string `--contracts`, and `--contracts`, by then the last word on the line, found nothing after it and fell back to its default, which switched it off. The server started, offered script tools aimed at a directory named `--contracts`, offered no contract tools at all, and said nothing about either. Every value-taking flag was affected: `--sign --scripts ./x` took `"--scripts"` as the key file just as willingly. Nothing any of them takes — a directory, a url, a peer name, a key file, a number — begins with `--`, so a value that does is a missing one, and the command is now refused with the flag named. The refusal is a sentence rather than a stack trace: these are read before any promise exists, so the entry point needed its own catch.
- **`save_contract` could not create its own directory.** It wrote straight to the path, so `--contracts ./contracts` worked only if you had already made the directory by hand — a tool advertised at startup and then failing `ENOENT` on the first thing asked of it, which reads as a broken server rather than as a directory nobody created. `saveScript` has made the scripts directory since it was written; this now matches it.
- **`list_contracts` reported a directory that did not exist yet as an error.** `list_scripts` answers with an empty list from the same state, for the reason written above it: not yet created is not an error, it is an empty directory. A directory that is there and cannot be read still is one.
- **A failure repeated its own code.** `node:fs` errors already open with theirs, so prefixing produced `ENOENT: ENOENT: no such file or directory` — the same thing appearing to have gone wrong twice. An RPC error carries its code apart from its message, which is the case the prefix exists for, so the prefix is now added only when it is not already there.
- **`list_scripts` says which directory it read.** An empty list from the directory you meant and an empty list from one you did not are the same two characters, and the first fault above produces exactly the second. The tool returns `{ directory, scripts }` rather than a bare array, or `{ node, scripts }` when aimed at another machine, whose directory is a path this server cannot see. The `scripting` RPC contract behind it is unchanged.

## Source RPC 3.4.0

### `source-rpc node`

A machine that can be scripted from elsewhere, and does nothing else. `mcp --scripts --scriptable-by` already offered this, and on the machine a model is attached to that is the right shape — on a PLC in the corner of a test hall it is not, since there is no model and no use for a stdio protocol sitting idle beside the part that matters.

```
source-rpc node --scripts ./scripts --scriptable-by bench --broker mqtt://bus:1883 --sign plc.json
```

Both flags are required, unlike on `mcp` which can sensibly take one without the other. A node with no directory has nothing to offer and one that names nobody offers it to nobody; either way it takes a peer name and does nothing, which reads as though it works. It also says at startup when it is on a broker without `--sign`, because nothing can prove who a caller is there and every scripting call will be refused.

### Fixed

- **A scripting namespace could be exposed a moment too late.** Both this command and the `mcp` wiring exposed the service after `ready()`. A resumed MQTT session is handed its queued messages the instant it connects, so a request waiting there reached a peer that had not exposed the namespace yet and was answered `ClassNotFound` by a peer that serves it perfectly well a second later — the hazard the frame spec lists under known limits. `connectNetwork` takes an `expose` callback that runs before `ready()`, so both are fixed at one seam.

## Source RPC 3.3.0

**Node 22 or later.** The floor was `>=18.17`, which claimed two majors that are both end of life — 18 since April 2025, 20 since April 2026 — and that CI had never once run. A supported range nobody tests is a guess with a version number on it.

22 rather than 24: it is what CI runs, what the Windows job runs, and what a current Windows IoT box has. Nothing else changed, so a peer already on 22 needs nothing from this release.

A major by the letter of semver, since a consumer pinning `engine-strict` on an older Node gets a hard failure rather than a warning. Released as a minor because the runtimes being dropped are unmaintained and were never verified against, which makes this a correction to a claim rather than a withdrawal of support.

## Source RPC 3.2.0

### Scripting a node from another node

`--scripts` could only reach the machine it was running on. `--scriptable-by <peer>` offers the same capability as an ordinary RPC namespace, so a bench drives a hall of nodes instead of a row of remote desktops. Every MCP script tool gains a `node` argument, absent meaning this one.

- **A service, not a server subclass** — `ScriptingService` composes onto whatever a node already is, the way `BusService` and `ConsoleService` do. Everything built for calling a peer then works on it: argument checking from the contract, `describe()`, the verbs, and the command semantics, which are declared and now committed as a contract that `check` polices.
- **The grant is made on the node being scripted.** Name nobody, the default, and the namespace is not published at all — `--scripts` alone is a machine that can script itself and cannot be scripted. A call arriving over RPC is refused unless the caller is authenticated *and* named; local use is the object held directly, with no RPC involved.
- **Through a bus it has to be signed.** Identity is per connection and does not survive a relay, so a hall of nodes on one socket.io bus cannot use this and no flag makes it — the information is not there. A signature is on the frame, so MQTT with `--sign` at both ends is the arrangement that works. Both working shapes have tests.

### Fixed

- **A Python simulator whose interpreter stopped reading took the whole fake down.** Writing to a dead child's stdin raises EPIPE, and an unhandled `'error'` on a stream is an uncaught exception. Failed calls now, rather than a failed process.
- **`npm` could not be run on Windows.** It was reached through `npm.cmd`, which Node refuses to spawn without a shell since the fix for CVE-2024-27980 — and a shell would have turned the `>`, `<`, `|` and `^` that are legal in a version range into a command line. It goes through `npm-cli.js` and the current Node instead.
- **`python3` is not the interpreter name on Windows.** Candidates are per platform now, `py` first there, and probed rather than assumed, since Windows ships a `python` that is a Store stub and fails like a missing one.
- `--scripts` announces itself on startup the way `--allow-exec` does. It is the larger grant of the two and was the quieter one.

### Also

- CI runs build, typecheck and the suite on `windows-latest`. No broker there — service containers are Linux-only — so the MQTT tests skip, and why that is an acceptable gap is written in the workflow.
- The suite passes against Mosquitto as well as EMQX, so what it tests is MQTT 5 rather than one vendor's reading of it.

## Source RPC 3.1.0

Additive throughout: new modules, optional fields on existing interfaces, new flags. Nothing that existed in 3.0.0 changes behaviour.

### Simulating something that reacts

A fake built from a contract answers the same value every time, which is enough for a screen that needs something to draw and not enough for the behaviour an HMI is usually wrong about — a pump that ramps toward the setpoint it was last given, a batch that will not start twice.

- **`state` and `handlers` on a fake's script.** A method gets a JavaScript body, called with the caller's arguments over shared mutable state. `python` runs a program instead, started once and keeping state in its own variables, with `@rpc('namespace.method')` supplied by a shim. A handler wins over `returns` for the same method, so one script can carry both.
- Fakes now pass call arguments to their methods, which were previously discarded — the change that makes a handler worth having.
- **`--allow-exec` gates both**, and is off by default. A script asking for them without the flag is refused at startup rather than served with its handlers quietly dropped, because that failure looks like it worked. The JavaScript context has no `require`, `process` or filesystem and a handler that will not finish is cut off; `node:vm` is not a security mechanism and Python has no confinement at all, so the flag is the boundary rather than the runtime.

### Peers kept as scripts

- **`--scripts <dir>` on `mcp`** — a directory of peers written as programs, which a model can add to, change, start, stop and read the output of. Unlike a fake, a script is not bound to one contract and can call as well as answer.
- **TypeScript by default**, run directly by Node with no build step, so a script can `import type` a class and get the same typed proxy the rest of the codebase does. The `--experimental-strip-types` flag is passed only on the versions that need it, and a Node older than 22.6 is told to use `.mjs` rather than failing obscurely.
- Each script is its own process, handed the network as `SOURCE_RPC_HUB`, `SOURCE_RPC_BROKER`, `SOURCE_RPC_PREFIX` and `SOURCE_RPC_TOKEN` so it reads its broker url rather than carrying one. Stopped when the server exits rather than orphaned holding peer names.
- **`list_packages`, `add_package`, `remove_package`** give the directory its own dependencies, in its own `package.json` and `node_modules`. Installs pass `--ignore-scripts` unless asked otherwise, because a `postinstall` hook is unreviewed code from the registry. Not a new grant — `--scripts` already permits arbitrary processes — but a declared one.
- That manifest also carries `"type": "module"`, which a `.ts` script needs: Node decides whether `import` is legal from the nearest manifest, and inside a CommonJS project it would otherwise warn on every run and put the warning in the script's own output.

### Two images

- **`ghcr.io/source-repo/rpc-cli:dev`** carries `npm` and `python3`, which `--scripts` and Python handlers need in order to work at all. The default image drops npm entirely: nothing at runtime shells out to it, and keeping it means inheriting every advisory against its bundled `tar`, `undici` and `brace-expansion`. The runtime image has no fixable critical or high vulnerabilities; the development one has five, which is the trade the split exists to make.
- On Node 24 (active LTS) with `apk upgrade`, and `latest` still points at the runtime image.
- The release scans what it is about to push and **blocks on anything fixable**; a weekly workflow scans what is already published, since an image is frozen at the day it was built and the advisory usually arrives later.

### Documentation

- Three task-shaped guides that cross both packages: [deploying a network](docs/deploying-a-network.md), [writing a simulator](docs/writing-a-simulator.md), and [the security model](docs/security-model.md). The package READMEs stay the complete reference, since they are also the npm pages.
- The front page now says what this is for and, early, who should use [tRPC](https://trpc.io) instead. Both package READMEs were reordered — the browser console was the last section of the CLI README and a 42-row flag table was the third screen.

### Corrections to the documentation

Found by reading the source rather than the prose:

- The introspection namespace is `msgrpc`, not `source-rpc`; the README said both.
- A client's default name is three readable words, not a UUID — and the reasoning was inverted, since the readable name exists *because* a UUID says nothing in a log.
- Multi-hop routing is covered by a test at two hops, not three.
- An undeliverable frame is now *answered* with a `TransportError` down the link it arrived on, not merely reported as `unroutable`.
- `MqttTransportOptions.tap` was missing from the options table.
- **Handler-chosen error codes** and **`--idempotency-key`** were both shipped and tested but undocumented.

## Source RPC 3.0.0

**Renamed.** `msgrpc` is now Source RPC: `@source-repo/rpc` → `@source-repo/rpc`, `@source-repo/rpc-cli` → `@source-repo/rpc-cli`, and the command `msgrpc` → `source-rpc`. `msg` was always meant as *message*, which is what this is about, but it is a short word full of other people's abbreviations and it reads as a puzzle to anyone meeting it for the first time.

**The protocol did not change.** Topic prefixes are still `msgrpc/v1` and `msgrpc/v2`, introspection is still the `msgrpc` namespace, MQTT 5 user properties still carry the `mr-` prefix, and the 3.1.1 header is unchanged. Those are on the wire: renaming them would strand every deployed peer and buy nothing. The default contract filename stays `msgrpc.types.json` for the same reason - it is what existing projects have on disk, and a rename would break their `--against` for tidiness alone.

Both packages go to 3.0.0 together, since a renamed package is a breaking change however compatible the code is.

### Industrial command semantics

Most RPC libraries make it easy to call a function. Rather fewer distinguish *the call failed* from *I lost the answer to a command that may well have run*, and on a plant that is the distinction that decides whether an operator sends a second start.

- **A method can say what calling it does to the world**: `@rpc({ semantics: 'query' })`, `'idempotent-command'` or `'non-repeatable-command'`. It is part of the contract rather than a comment - `extract` reads it off the decorator, `describe()` reports it, and `check` calls it a breaking change when a method becomes *more* dangerous to repeat than the version a caller was built against. Every type still lines up in that case, which is why nothing else catches it. Undeclared stays undeclared: the library will not guess that a method is safe to repeat.
- **`UnknownOutcome`**, a new error code, for a request that was sent and whose fate is not known. `TransportError` now means the request never left, so the command certainly did not run. Both used to be reported the same way, which told a caller that a command had failed when what the library knew was that it had lost track of it.
- **A durable idempotency hook.** `RpcIdempotencyStore` given to `RpcServer` records what a non-repeatable command did, so a redelivery after the process died is answered from the record rather than executed again - the one failure an in-memory duplicate cache cannot cover, since the memory is what died. No database ships with it; the seam is the deliverable. The outcome is recorded *before* the answer goes out, and a store that cannot be reached refuses the command rather than running it - failing open would produce exactly the double execution it prevents.
  - Consulted only for non-repeatable commands, so reads pay nothing for it.
  - `proxy.$with({ idempotencyKey })` lets a caller say that two attempts are one command, which is the case the request id cannot cover: an operator pressing the button again is a new request but the same intent. Carried as `mr-idem` on MQTT 5 and signed like everything else acted on.
- **An execution policy per exposed instance.** `@rpcNamespace('cell', { execution: 'serial' })` runs one call at a time; a key function runs one at a time per key, which is how a server fronting many devices orders each device without serialising itself behind the slowest. Calls into one mutable instance could otherwise interleave and leave a machine in a state neither caller asked for. `parallel` stays the default because a serial instance that calls back into itself deadlocks, and changing the default would break re-entrant designs silently and only under load.
  - The deadline is read *after* waiting in that queue, so a command that queued until its caller gave up is refused rather than run late.
- Stated plainly in the README, because it is true and usually unwritten: **delivery and execution are at least once unless the method is guarded by a durable idempotency store.**

Deliberately not built, with reasons in the README: cancellation, `online-only` delivery, a per-call invocation context for handlers, and global admission limits.

### A bus you can deploy

- **Well-known ports.** `defaultWebSocketPort` is **7843** and `defaultWebPort` is **7844**, where anything serving a browser listens. `source-rpc broker` and `source-rpc console` default to them, replacing 3000 for the library default, 8080 for the broker and 7300 for the console — one number to remember instead of three. Deliberately clear of the 80xx range: 8080, 8081 and 8085 are taken on any machine that has been worked on for a while, and a default that collides on the laptop is a default nobody keeps. A single process still needs only one port, since a page and its RPC share a listener; the second number is for running a bus and a console on one host.
- **`source-rpc broker --auth <file>`**, and `authenticate` on `startBroker`. The library has had an `authenticate` hook since 2.0, but nothing on the broker forwarded it and no flag reached it — so the command printed *"use authenticate to gate that"*, which was advice its own user could not take. A bus can now be put on a network that is not already trusted.
  - **`createTokenAuthenticator`** packages the common case: a map from bearer token to the peer it admits. One token per peer, deliberately, with no single-secret form — a token that maps to a name is evidence of who is calling, and a shared one proves only that the caller is inside the fence. Blank tokens, grants with no name and an empty map throw rather than construct.
  - `--auth` names a path, never a secret; `SOURCE_RPC_TOKEN` and `SOURCE_RPC_TOKENS` say the same two things for a container. The same flag gives every other command the credentials to join a hub that authenticates, which `hubCredentials` previously had no way to receive.
- **A container.** `packages/cli/Dockerfile` builds an image whose entrypoint is the whole CLI, so one image is a bus, a console, an MCP server or a recorder depending on the command. `docker-compose/network.yml` runs an MQTT broker, a bus and a console together.
- **The console can be published under a path by a reverse proxy.** Its assets were already relative, but two runtime paths were not: it fetched `/console.json` and connected to `window.location.origin`, both of which leave the mount point behind and land on whatever else is published at the root. The page now derives both from `document.baseURI`, so no configuration is needed as long as the proxy strips the prefix and the published path ends in a slash.
  - **`--base-path`** covers the proxy that forwards the prefix instead. The page, its assets, `console.json` and socket.io all move to it, `/` stops answering — the rest of that origin belongs to whatever is published beside the console — and the mount point without its trailing slash redirects to the one with it, which is the only place relative paths can be put right.

### Security

- **An authenticating socket.io transport registered peer names it had just rejected.** A frame's source is recorded in the shared peer registry as the header is parsed, which is right for MQTT — the broker is the authority there and there is no connection anyone could check — but on a transport with an authenticator it happened before the identity check, and so applied to frames that were then dropped. Sending one rejected frame was enough to have a bus advertise a peer that did not exist, and to point lookups for a real peer's name at a transport where nothing answers to it. Delivery was never affected — that reads a map only the post-check path writes — so the effect was disruption rather than interception. Registration now happens where the trust decision is made. Nothing changes without an authenticator, where a name was never evidence to begin with.
- **A signed MQTT 5 frame's content type was not covered by its signature**, and altering it could change what the frame said while the signature stayed valid. The reasoning written into the code was that content type only says how to read bytes that are themselves signed, so changing it could make a payload fail to parse but never change what was authorised. That is wrong, and the counterexample is one byte long: `0x31` is the JSON text `"1"`, the number 1, and is also a MsgPack positive fixint, the number 49. Both parse. Both verified. Flipping one unsigned property therefore turned a signed `write(1)` into a signed `write(49)`.
  - The **error code** and the **declared contract version** were uncovered for the same reason and are now signed too. The code is what a caller acts on when a call fails, and the contract version decides whether the call is accepted at all - neither is merely transported.
  - **Signed frame version 2.** A frame signed under version 1 no longer verifies, which is deliberate: accepting either would let a sender choose the weaker form. The gate is on the *signing* path only, so **plain MQTT 5 peers written against version 1 keep working** - an unsigned frame's version says nothing about security, and the interop that makes this a protocol rather than a library is worth keeping. A peer that signs must be upgraded.
  - **An unknown content type is refused** rather than falling back to MsgPack. Guessing how to read somebody else's bytes decides what the values mean.
  - Found in the OpenAI review of 2.3.0, whose reasoning was right in every particular.
- **TLS certificate verification was off by default.** The socket.io client transport set `rejectUnauthorized: false` before applying the caller's own options, so every Node peer accepted any certificate at all - which on this library's traffic means accepting an impersonated server for industrial commands. Node's default is now left alone. Where a development server really does have a self-signed certificate there is `allowInsecureTls`, on the client, the transport and the CLI's `--insecure-tls`, which says what it does, warns when it is used on a TLS link, and is off. A plant with its own certificate authority should pass the CA instead, which keeps verification on rather than switching it off.
- **`{ https: true }` opened a server with no certificate.** It called `createHttpsServer()` with nothing in it: the port listened, and every handshake then failed. Replaced by `tls: { cert, key }`
  - the material is what asks for HTTPS, because there is no useful HTTPS server without it. The old spelling is refused with a message pointing at the new one, in the types and at runtime, rather than silently falling back to plain HTTP.
- **The incoming MQTT 5 Response Topic is now honoured.** A request's reply used to go to a topic derived from `mr-src` rather than to the Response Topic the packet named. The interop tests passed only because the third-party client happened to choose the same topic msgrpc would have derived; a standards-compliant caller picking any other valid topic was never answered where it was waiting. The topic is validated (no wildcards, no control characters, not under `$`) and must sit under the transport's prefix, which `allowResponseTopic` overrides - a caller now chooses a topic somebody else publishes to, so it needs a boundary. It is signed for the same reason. A request naming a topic outside the rule is refused rather than quietly answered elsewhere.
- **A request could execute after its caller had given up.** The call timeout defaulted to 10 seconds and the MQTT request expiry to 30, set independently, so a queued request could be delivered and run twenty seconds after the operator had been told the call failed. For a read that is wasted work; for `start pump` or `reset fault` it is a machine moving when nobody expects it.
  - A request now carries `mr-ttl`, the milliseconds its caller will still wait, and **the broker's expiry is derived from it** rather than set independently.
  - The server **checks the budget immediately before invoking the method** and answers `Timeout` instead of running it. The broker's expiry only covers the queue at the broker; a request that arrived promptly and then waited on something slow inside the serving process needs the check.
  - **A duration, not an absolute deadline** - which is where this departs from the review's suggestion. An absolute deadline is only as good as the agreement between two clocks, and one of the peers here is a browser page whose clock belongs to whoever is sitting at it: a wrong clock would refuse every command that page sent, which is a worse failure than the one being fixed. The receiver counts from its own arrival stamp, and on MQTT 5 the broker's decremented expiry accounts for the queueing - so nobody's clock is ever compared to anybody else's. `mr-ttl` is signed, and the expiry may only narrow it.
  - `refuseExpiredCalls` on the server handler turns the refusal off for anyone who wants the old behaviour.

### Fixed

- **Piping a verb into `head` printed a stack trace.** Closing stdout early makes Node emit an unhandled `error` event, so `source-rpc describe plantServer | head -4` ended in `EPIPE` and a stack trace instead of simply stopping. Handled at the entry point, since every verb writes to stdout and half the documented examples are pipelines. Found by running one of those examples.

### Everything below shipped as msgrpc 2.4.0 and msgrpc-cli 2.5.0

- **The traffic tap.** `msgrpc broker` now exposes a `bus` namespace — `tap(filter?)`, `untap`, `taps()` — and emits a `frame` event carrying what it is relaying. A console only ever sees its own calls and the events it subscribed to, which on a real network is a small fraction of what is happening; the broker sees everything, because it is the thing forwarding it.
  - **Turned on by a call, not by a flag.** A plant bus that has to be restarted before it can be watched will not be watched: the run worth looking at is the one already going wrong.
  - **It knows what a frame is**, which is what a topic browser pointed at the same wire cannot do. A call and its reply share a correlation id, so the reply is reported with the method it answers and the time it took — neither of which is in the reply itself.
  - Filters narrow by peer (either direction — "mirror that device"), namespace, and kind. Several taps run at once with different filters, and each frame names the taps it matched.
  - **Payloads are off by default.** The metadata is what a debugging session usually needs, and a plant bus carries values nobody meant to hand to whoever happened to be tapping. They are carried only if one of the taps that matched asked for them.
  - Taps expire on their own (300 s by default, 3600 s at most). A console that closes without untapping would otherwise leave the broker building and emitting frames for a subscriber that is not there. The calls awaiting replies are dropped with the last tap, so nothing accumulates between debugging sessions.
  - Traffic addressed *to* the broker is not tapped, only what it relays, so reading the tap back does not feed itself.
- **The broker describes itself.** It used to expose nothing at all, so a peer addressing it got `ClassNotFound` — true, and the plainest possible statement that this is a switchboard rather than a service. It was also indistinguishable from a device whose server was started without `exposeIntrospection`, which is what a broker in a peer list actually looked like. It now ships a contract and answers `describe`, so `msgrpc describe plantBus` says `bus@1` instead of an error that reads like a fault.
- **The tap works on MQTT too**, where there is no broker of ours to hook: the observation happens at the subscription instead — `<prefix>/rpc/+` under 3.1.1, each of `<prefix>/{req,rsp,evt}/+` under MQTT 5 — and a console started with `--broker` exposes the same `bus` and watches for itself. `MqttTransport` takes a `tap` option for it, and reports what it decodes rather than delivering it: a tap answers no calls and runs no methods.
  - **It gets its own broker connection**, opened when the first tap starts and closed after the last ends. A peer subscribed to both its own topic and the wildcard covering it has overlapping subscriptions, and a broker may deliver a matching message once per subscription — which for a request means the method runs twice. A separate instance is a separate client id and session, so the two can never overlap; there is a test asserting the device ran the method exactly once per call while tapped. It also means an idle console costs a plant broker nothing.
  - Frames are reported without checking signatures. A tap holds no key for a conversation it is not part of, and what is on the wire is what it exists to show.
- **`console.tap`, `untap` and `taps`**, so the page asks the console rather than hunting for a broker from the browser. The console turns on whatever it can reach — a broker's `bus` over socket.io, its own subscription over MQTT, both when it holds both links — and says which in `sources`. Frames arrive on one `frame` event either way.
  - Peers are described **in parallel** when looking for a bus. One peer that is registered but no longer answering — a page whose tab was closed — takes the whole call timeout to fail, and in sequence that was one timeout per stale peer before the tap started at all.
  - The console's record of a tap is given the same life as the tap it stands for, so a page that reloads without untapping takes its entry with it instead of leaving one for the life of the console.
- **A Traffic tab in the console**, next to Events and Chat: off until asked, with the filter set up before it starts, then one row per frame colour-coded by kind, a search box and a pause. It stays tapping while another tab is showing — unmounting it would have stopped the watching exactly while you looked away — and the count on the tab label is what arrived meanwhile.
- **`msgrpc bench`** calls one method over and over and reports what it cost. A device is fine at one call a second; what it does at twenty is the question, and answering it is ordinarily done with a script that is always the same script. **Percentiles rather than an average**, because an average hides exactly the calls worth knowing about - a device answering in 2 ms with one reply in four seconds averages out to something that looks healthy. Failures are counted by code, since a device refusing arguments and a device that stopped answering are different findings with the same shape, and any failure exits 1 because errors under load are the finding.
  - `--concurrency` bounds what may be outstanding; past that calls are **not sent and counted as fallen behind**. Piling them onto a device that is already behind measures the queue rather than the device, and would report healthy latencies for a device that is drowning.
- **A Presence tab.** A peer that flaps is one of the commonest faults on a plant and the hardest to catch in the act: the console showed it as a dot that changed colour and then forgot, so a device dropping every thirty seconds looked exactly like one that was simply up. The console keeps the arrivals and departures and hands them over when a page connects, so opening it after the trouble still shows it, and a peer that has arrived three times or more in the window is called out by name.
- **Peers say what they are** - broker, console, page, device, or served without a contract. Learned from descriptions the console was already making when someone selects a peer or when it goes looking for a bus to tap, so the labels fill in as the network is used and an idle console costs what it always did. The worry that this needed a describe per peer on sight is what had kept it out; it does not.
- **Argument presets**, per method and kept in the browser. Keyed by namespace and method rather than by peer, so a set saved against one cell is offered on the next - the reason to save a setpoint sequence usually being that five more cabinets are coming. Named by what they hold, so there is no dialog to name them in.
- **Console polish.** The events pane gained the filter, pause and export the traffic tab already had - pausing stops the buffer filling rather than only the list rendering, and export writes the jsonl `msgrpc record` writes and `jq` reads. **Watch all** takes every event in a namespace in one click, which is the usual first move on an unfamiliar peer. Each method keeps its timings, with **×20** to call it repeatedly and report `20 calls · p50 1 ms · last 1 ms` - `bench` in miniature, for when the question is smaller than a benchmark. **copy as CLI** puts the equivalent `msgrpc call …` on the clipboard with the network flags this console was started with, because a call worth making in a browser is usually one worth putting in a script and retyping `--hub http://…` from memory is where that stops happening.
- **The MCP server can stand a peer up, and reaches the rest of this release.** Asking a model to test a device runs into the device having to exist first, and the steps that closed that gap - write a JSON file somewhere, open a second terminal, start the CLI - are exactly the ones a conversation cannot take. `start_fake` takes a contract **inline** and puts a peer on the network that answers from it; `stop_fake` and `list_fakes` manage them. They run inside the MCP server rather than as spawned processes, so they stop when it does and none are left behind.
  - **A fake will not take a name a peer already answers to.** Standing one up under a live device's name would displace it, and calls meant for the plant would reach a stand-in that agrees with everything. Refused, not resolved.
  - `check_peer` and `diff_peers` are the conformance verbs; `watch_traffic` returns what other peers said to each other over a few seconds, and `watch_events` what one peer emitted, dropping the subscription again so looking leaves nothing behind. Both are bounded, since a model asking for an hour would get one and the conversation would look hung.
  - `save_contract` and `list_contracts` appear **only when `--contracts <dir>` names somewhere to write**. A server that cannot write files should not advertise tools claiming it can. Contracts are written as `<name>.types.json` in that directory and nowhere else - a name that would climb out of it is refused rather than resolved - and the file is the one `msgrpc serve --contract` and `msgrpc check --peer --against` already read, so the loop closes.
- **`msgrpc check --peer`** points the build-time check at a device. `check` against source catches a change before it ships; what it could not answer is the question asked on site - the contract says this device offers `writeSetpoint(value, mode?)`, is that what the box on the wall is running? The peer describes itself and the answer runs through **the same comparison** the server applies to a caller declaring an older version, so a device behind its own contract is reported in exactly the words a stale caller would have got, and CI and the site agree about what "breaking" means.
  - A namespace the peer does not serve at all is reported apart from one that changed, and **a peer running without a schema is reported as unchecked rather than as passing**. It describes its method names and nothing else, and calling that "no breaking changes" would be the most useful-sounding lie available.
- **`msgrpc diff <peerA> <peerB>`** for the question that follows: why does cell 3 behave differently from cell 2? Contract versions, methods one has and the other does not, signatures that changed and events one no longer emits, side by side. Signatures are compared as they read rather than structurally, because the answer is read by a person standing in front of two cabinets. Exits 1 on any difference, so a script can assert that two cells match.
- **`msgrpc record` and `msgrpc replay`.** The tap already produces correlated, self-describing frames, so a recording is that stream in a file - jsonl, so `grep`, `jq` and `wc -l` work on it, and appended as frames arrive so a process killed mid-session still leaves what it saw. What it is for is the question a plant asks constantly and no test framework answers: this new device is supposed to behave like the old one, does it? `replay` re-issues the recorded calls in their original spacing, compares each answer with the one recorded, and **exits 1 when anything differed or failed**, so a conformance check is a line in a CI file.
  - `Date` and `Uint8Array` are tagged in the file and restored on the way back. JSON carries neither, and a timestamp that replayed as a string is not what the device received - the same reason this library speaks MsgPack in the first place.
  - **A call that failed the same way it failed when recorded is a match.** A replacement that refuses what the old one refused is behaving, and counting that against it would make every recording of a real plant unusable. A call with nothing recorded to compare against is counted apart rather than as a pass, and one recorded without payloads is reported rather than sent empty - calling the method with nothing and comparing that is the worse answer.
  - Payloads are on by default for `record`, where the tap has them off: a recording without arguments and results cannot be replayed, which is the only reason to make one. It says so on startup.
- **`msgrpc serve`** stands a peer up from a contract, so an HMI has something to talk to and a test has a device willing to fail on request — which a real one is not. It answers every method with a value of the declared shape and **refuses what the real peer would refuse**, since it is handed the same schema and runs the same validator. The contract is the one already extracted and committed for the deployed peer, so the stand-in cannot drift from it: `msgrpc check` fails the build when it would.
  - Generated values are deterministic and inside whatever the type language carries — the midpoint of a range, required fields only, the first non-null option of a union. A fake whose readings wander is pleasant to look at and impossible to assert on. `pattern` is the one constraint it cannot honour, and a recursive type stops rather than descending forever.
  - `--script` supplies canned returns, deliberate failures and events on a timer; `--fail ns.method=Code` is the same without a file. **`Timeout` is the special code: the call is never answered at all**, so the caller's own timeout is what fires — the failure an HMI handles worst and the one otherwise staged by pulling a cable. Only the named method is affected, so a test can break one thing rather than the device.
  - It says it is a fake on startup and in the class name a console shows, because a stand-in mistaken for the device is worse than no stand-in at all.
- **A method can choose its error code** by throwing an error carrying one. Everything a method threw came back as `Exception`, so a service that wanted to say "you may not do that" could say it only in the message, and a caller reading `code` to decide whether to retry, re-authenticate or give up learned nothing from it. Restricted to the codes the protocol already defines — `Unauthorized`, `Forbidden`, `InvalidParams`, `IncompatibleVersion`, `ClassNotFound`, `MethodNotFound`, `TransportError`, `Timeout` — so an error carrying an unrelated `code`, a Node `ENOENT` say, is still reported as the exception it is. **This changes what callers see** from a method that already throws such an error: the code is now that one rather than `Exception`, and the message is unchanged.
- **A Problems tab**, and `console.problems` behind it. The transports have always emitted `rejected`, `unroutable`, `peerDisplaced` and `transportError`, and the console listened to none of them — it wired up `peerOnline`/`peerGone` and dropped the rest. Between them those four cover every way a call disappears without an answer: refused before the RPC layer, nowhere to deliver it, a name two peers are both answering to, or a link that failed underneath. Until now all of it arrived as an unexplained timeout, which is the hardest kind of problem to diagnose and the one this tooling exists to make visible.
  - **Kept as well as streamed.** Nothing to switch on, a bounded history, and the page is handed what happened before it was opened — because nobody opens the console until something is already wrong.
- **Each peer says which link it was found on.** `console.ts` looped over `network.transports` to build the online set and threw the transport away, so a console holding a browser link, a broker and a hub at once could not say which one a peer was on. Peers already connected when the console starts get theirs from the registry, which is how they were discovered in the first place.
- The console's own contract now **declares its events**. It described five methods and none of its three events, so a console pointed at another one showed an empty event list on a service that emits `event`, `peer` and now `frame`.
- **`TransportEvent.relayed`** reports a frame a server is passing between two other peers — the only place traffic nobody here sent or received can be observed. Emitted from the one point both relay paths cross, so a frame moving to another transport is reported too and a tap on a mixed network does not quietly miss half of it. Guarded on the listener count, since it runs per frame and building the object for nobody is the cost.

- **`msgrpc peers`, `describe`, `call` and `watch`** — the console's verbs for a shell rather than a browser. Everything the network could be asked was reachable only through `console`, which needs a browser, or `mcp`, which needs a model on the other end; a shell script and a CI job had neither. These take the same network flags, answer once, and exit 1 when a peer refuses, which is what makes a smoke test a line in a CI file instead of a program that parses output.
  - **Arguments come from the peer's own contract.** A shell has only strings, so the peer is described first and its schema decides what each word means: `1200` is a number where the contract says `number` and the text `1200` where it says `string`, `auto` matches a literal in a union, `bytes` takes hex and `date` takes an ISO string. Without this, `msgrpc call plant plant.writeSetpoint 1200` sends `"1200"` and comes back `InvalidParams: expected number, got string` — correct, and useless. Where a peer publishes no contract the rule is JSON-if-it-parses and the literal text otherwise, so `42` is a number and `hello` is a string rather than a syntax error. `--args '[…]'` is the escape hatch.
  - A word that cannot be what the contract asks for is refused before anything is sent, and the argument is **named rather than numbered**: `argument 0 (celsius): expected a number, got 'warm'`.
  - `--json` on every verb, rather than guessing from whether stdout is a tty — that guess is wrong exactly when it matters. `call` puts the result on stdout and the timing on stderr, so a pipe carries the value and nothing else. `watch` writes jsonl, since a stream that is pleasant to read is a stream nothing can parse.
  - Each verb waits up to `--wait` for the peer to become addressable. `ready()` means the links are up, not that presence has arrived, and a one-shot command that gave up on that gap would fail intermittently for reasons nobody could reproduce.
  - Ctrl-C on `watch` drops the server's subscription as well as stopping the stream, so a debugging session leaves no listeners behind on a device that outlives it.
- Joining a network is now one function rather than three copies of twenty lines. `console`, `mcp` and the verbs built the same transport list each, which is three places to forget `--prefix` in, and the same two checks — that there is something to join, and that a `--name` does not contradict the name the key file belongs to.

### Fixed

- **The console page sometimes failed to reach the console on load**, reporting `no response to console.on within 10000 ms` and listing no peers, on roughly one load in two when loads followed each other quickly. The page opened an `RpcServer` and closed it in React's effect cleanup, which does not run when a document is torn down by a navigation - so every page navigated away from left its connection behind, and remained a peer in everyone's list, still being sent the events it had subscribed to, until the console reaped it. socket.io connects over HTTP long-polling, so each of those held a long-lived request against the console's origin, and Chrome allows six concurrent connections per host: five stale pages plus a new one's handshake is exactly six, and the new page's poll queued behind requests that would not return. It now closes on `pagehide`, which covers navigation, tab close and the back/forward cache where `unload` is unreliable. Three loads left five stale peers before and none after.
  - The page also **retries the handshake** three times before giving up, so the console recovers rather than sitting there with an error and an empty peer list - a poor answer from the thing you opened to find out what was wrong.

### Security

- Anyone who can reach an unauthenticated broker can now call `bus.tap()` and mirror everything crossing it. They could always have read the same traffic by impersonating a peer — the broker has never checked who anyone is — but not this conveniently. `authenticate` and `relay` are what gate it, and the broker now says so on startup next to the warning it already printed about relaying for whoever connects.

## msgrpc-cli 2.4.1

- The `msgrpc` binary is made executable at build time. `tsc` writes `dist/index.js` with a shebang but no executable bit; npm sets it when installing a published tarball, so the published package was fine and a workspace checkout was not. `npx @source-repo/rpc-cli` run from inside this repo resolves to the workspace copy and died with `sh: 1: msgrpc: Permission denied` - which an MCP client reports only as "Connection closed".

## msgrpc 2.3.0 and msgrpc-cli 2.4.0

- **`msgrpc mcp`** serves a live network to an [MCP](https://modelcontextprotocol.io) client over stdio, so a model can look at a plant the way a person looks at the console. Three tools - `list_peers`, `describe_peer`, `call_method` - rather than one tool per method on the network: a peer set that changes mid-conversation would mean re-issuing the tool list on every arrival and departure, and `describe_peer` hands over the argument types instead. A call a peer refuses comes back as tool content carrying the reason, not as a JSON-RPC failure, because a model can act on the first and not the second. No MCP SDK behind it - MCP is JSON-RPC 2.0 over newline-delimited stdio, and this package is about not needing a second RPC framework.
- **A name collision is reported on MQTT 3.1.1 too**, where it has to be inferred rather than read: 3.1.1 has no reason codes, so a session taken over looks exactly like the link dropping - except that it does not stop, because two peers sharing a client id evict each other on sight and neither connection outlives the next one's arrival. Three connections in a row that die young are reported as a suspected collision, and said to be a guess, since a network flapping this hard looks the same. MQTT 5 still says so outright with reason code `0x8E`.

### Fixed

- **`SocketIoClientTransport.close()` returned before the connection was closed.** `disconnect()` only starts it: a close packet goes out and it returns, leaving the engine's ping timer armed until the transport is actually torn down. So a promise that was supposed to mean "closed" resolved while the connection was still running - the mirror of what the server transport already got right, where `io.close()` and the HTTP server's close are both awaited. This was also the intermittent hang after a passing test suite, which ava 8 reports as a failure rather than a warning: 4 reproductions in 40 runs before, 0 in 40 after.
- socket.io connections are refused while a server is closing, at the handshake, so one completing inside that window cannot outlive the sweep that was meant to disconnect it.
- `GenericModule.ready()` polled with no way out, so a module that never became ready - one that failed to start, or was closed while something still awaited it - spun on a 10 ms timer for the life of the process, which is also enough to keep the process alive with nothing left to do. It now gives up and returns false.

## msgrpc 2.2.0 and msgrpc-cli 2.3.0

**Discovery and routing over socket.io**, so a network with no broker works the way an MQTT one always has - and so a server hosted in a browser page is a peer like any other.

- **Readable peer names.** The default is three hyphenated words from the BIP-39 English list (`brisk-otter-cable`) rather than a UUID. That list is 2048 words chosen to be unambiguous in their first four letters; the rest of BIP-39 - entropy sizes and a checksum - is for seed phrases and does not apply. A name is what a caller addresses, what presence lists, what a log line blames and, over MQTT, the broker's client id, and a UUID is none of those things legibly. `readableNameFrom(seed)` derives the same name from the same seed, for a peer meant to be recognised across restarts.
- **A browser can host an `RpcServer`.** `RpcServer` in Node is `NodeRpcServer`, which adds `{ port }`, `{ server }` and `{ brokerurl }`; in a browser the same name is the portable base, which has none of them. Source that sticks to `{ connect }` and transport instances is portable between the two, and `{ port: 8080 }` in browser code is a compile error rather than a runtime throw. Nothing a browser resolves imports socket.io's server or the MQTT client, so neither reaches the bundle without any bundler configuration.
- A listener that cannot bind now fails `ready()` with the reason - a port already in use is not something more waiting fixes - instead of being waited out for the full `readyTimeout`.
- **`RpcServer.proxy()`**, the mirror of `RpcClient.proxy`. A peer that both serves and calls now needs one object and one connection, under one name, rather than an `RpcServer` and an `RpcClient` under two - which over MQTT meant two broker sessions. Its subscriptions are replayed on reconnect the way a client's are.
- **A bus without a broker.** An `RpcServer` that exposes nothing and only relays is one; everything else joins with `{ connect: url }` and gets presence, addressing by name, and any-to-any calling.
- **More than one hop.** A peer announces the peers reachable *through* it as well as its own name, so a server that is a hub for its own peers and a member of a bus makes each visible to the other. Calls, replies and events all traverse it, and departures propagate. Verified to three hops. Split horizon - never advertising a peer back along the link it came from, in the broadcasts and in the snapshot handed to a newly connected peer - keeps two hubs from concluding the other is the way to a peer and losing it. Frames carry a hop count and are dropped after 8 relays, since a mesh that has just lost a link can hold a cycle until the tables settle. A peer offered by two links keeps the first and falls back to the second; a peer announcing itself outranks one merely carried.

- **Every peer announces itself on connect**, and is told who else is there. A socket.io server used to learn a peer only from the header of a frame it sent, so a peer that merely listened was invisible and could not be addressed at all. `peerOnline` and `peerGone` now come from both transports, so code watching a network no longer cares which one it is on.
- **`transports: [{ connect: url }]`** lets an `RpcServer` serve over a connection it opens. A browser cannot listen, so this is the only way a page can host a service; the hub relays calls to it.
- **A server relays for its connected peers.** A frame addressed to another peer it can see is forwarded instead of executed locally. `relay: false` forwards nothing, and a predicate decides per connection. The decision is remembered per pair of peers, because a rule written about the caller would otherwise strand the reply travelling the other way. A relaying server with no `authenticate` warns once, the first time it actually forwards something.
- **A server holding both a socket.io listener and a broker connection bridges them.** A browser peer discovers a peer that exists only on MQTT and calls it, with the call arriving under the browser peer's own name rather than the bridge's, so per-peer authorization and subscriptions still mean something. The bridge subscribes to the reply and event topics of the peers it forwards for, and publishes presence on their behalf - without that, a departing browser peer left its event subscriptions on the MQTT server forever.
- **`msgrpc console --hub <url>`**, on its own or alongside `--broker`. With both, one list covers both networks and each peer is called over the link it was found on.
- **`msgrpc broker`** runs a WebSocket bus until Ctrl-C, for networks with no MQTT broker to share: it relays between the peers that connect and tells each who else is there. `--upstream <url>` joins another broker, repeatable, and the two become one network - a peer on either is callable from the other. It is an `RpcServer` exposing nothing; there is no separate implementation.
- **A `record` kind in the schema type language**, for a dictionary whose keys are not known in advance: `{ [tag: string]: Reading }`, which is how plant data usually arrives. `extract` used to refuse an index signature outright, because describing one as an object with no properties produces a type that rejects every value. A record checks every value against one type and leaves the keys open, or constrains them with `keyPattern` - which is what a numeric index signature becomes, since a JS object key is always a string on the wire - and `maxEntries` bounds it the way `maxItems` bounds an array. It was also the first thing needed to describe msgrpc's own introspection output, which is built out of `{ [name: string]: TypeNode }`.
- **`describe()` describes itself.** The `msgrpc` namespace ships a contract extracted from its own source, so a peer reading a server sees the type it will get back. Its named types are prefixed `msgrpc.*`, because the schema has one type map shared by every namespace and a plant defining its own `TypeNode` should not find `describe()` described against it. A schema that already defines `msgrpc` is left untouched.
- **The console and the page it serves ship contracts too**, so pointing one console at another gives argument fields rather than `call(...)` and `say(...)`. `npm run contract` regenerates all three; a test asserts they still match the source they came from.
- **A name collision is reported rather than silent.** Both transports emit `TransportEvent.peerDisplaced` and warn once when a second peer turns up under a name already in use. The newcomer still takes the address - a peer reconnecting after a blip announces itself while the old connection may still look live, and refusing it would lock a peer out of its own name - but two peers genuinely sharing one used to send each other's replies into the wrong place, which reads as calls timing out for no reason. Over socket.io the server sees both connections; over MQTT the client id is derived from the peer name, so the broker hands the session over and tells the displaced peer why with reason code `0x8E` (MQTT 5 only).

### Fixed

- **A socket.io server executed calls addressed to another peer.** The target was tested only for being a name the server had heard of, never for being the server itself, so a call meant for someone else was answered by whoever it reached - with that server's own implementation, reported as success. It now forwards, or refuses; it never substitutes itself. A frame that can be neither delivered nor relayed is reported as `unroutable` rather than dropped in silence, which callers only ever saw as an unexplained timeout.
- `MqttTransport` set the response topic of a forwarded request to its own address, so a non-msgrpc peer honouring it would have replied to the wrong peer.
- A socket.io server reported itself ready before its port was bound, and had no handler for the listener's `error`. A port already in use therefore announced a running server and then took the process down with an unhandled event; it now waits for `listening` and reports the failure.
- `exposeIntrospection` with `validation: 'required'` refused `msgrpc.describe`, so the one call a peer makes to find out what a server offers was the only undescribed thing on it.
- `validateValue` returned "valid" for a node whose `kind` it did not recognise - a typo, or a document written for a later version of the language - which is an unchecked value wearing a checked type. It now refuses.
- `extract` keyed a generic instantiation under its bare alias, so `Record<string, number>` and `Record<string, string>` collapsed into one named type and the second silently became a reference to the first's value type. Instantiations are inlined instead.
- Every console page derived its peer name from the console's host, so every browser pointed at one console produced the same name and their replies went to whichever the server registered last. A page now takes a random readable name, kept in `sessionStorage` so a reload comes back as the same peer; `?name=` overrides it, the page's version of `--name`.

### Tests

- MQTT test peers get a 10 s session expiry. Names became unique per run in 2.1.1, which fixed one problem and created another: a server keeps a persistent session for an hour by default, so every run left another one behind. After a day of runs the broker held 1024 sessions and 3628 subscriptions and stopped accepting connections. The one test that is *about* the hour-long default keeps it and clears its own session afterwards.

### Breaking

- `new SocketIoClientTransport(url, sources, options)` is now `new SocketIoClientTransport(name, url, sources, options)`. A peer has to know its own name to announce it, the same way `MqttTransport` has always taken one. `RpcClient` passes its `name` through, so this only affects code constructing the transport directly.
- `TypeNode` gains a `record` variant. A schema written by hand needs no change, but code that switches exhaustively over the union has a new case to handle.

## msgrpc 2.1.1

Documentation and test hygiene; no change to shipped code.

- The quick start did not compile: `Calculator` was neither exported by the server snippet nor imported by the client one, and the client needs the class as a type to get a typed proxy. It is now a shared `calculator.ts` the client pulls in with `import type`, which is the point being made and was the thing left out.
- The MQTT example gave the server `prefix: 'site-4'` and the client no prefix at all, so the two could never reach each other. An `mqtt://` url takes the default prefix and there is no client option to change it, so the section now shows building the `MqttTransport` and says what the mismatch looks like: a bare call timeout.
- A **Connecting** section, which was missing entirely - transports against urls, peer names and targets, `ready()`/`close()`, and the MsgPack/JSON choice. The README went from the quick start to decorators and schemas without ever saying how to point a client at a real server.
- Reordered so the basics come first: exposing, errors, events, then schemas and versioning, then introspection, authentication and MQTT. Security and broker detail used to arrive before the ordinary reader had been shown a second method call.
- The opening sentence said "expose an instance", which read as though instances were incidental. It now says the instance is one live object that every call runs against, and the quick start demonstrates state surviving between calls.
- Exposing more than one namespace, and `exposeObject`, are both shown.

### Tests

- The MQTT tests gave every peer a fixed name, and a peer name is the broker's client id. A server keeps a persistent session, so a second run resumed the first run's session and was handed whatever it still had queued - which showed up as an occasional failure that never reproduced when the file was run on its own. Names and topic prefixes now carry a per-run suffix.
- `rpc traffic is published per peer` waited for two messages on the observed prefix before asserting, which the two presence announcements could satisfy on their own, leaving the reply still in flight. It now waits for the rpc topics it is actually about.

## msgrpc-cli 2.2.0

- **`msgrpc console` is now a React app, and it reaches the CLI over msgrpc itself.** The CLI runs an `RpcServer` on the same HTTP server that serves the page and exposes a `console` namespace (`peers`, `describe`, `call`, `watch`, `unwatch`) plus `event` and `peer` events; the browser is an ordinary `RpcClient`. The REST endpoints and the server-sent event stream are gone. The console is now the library's own first client, so a fault in event routing surfaces here before it reaches a plant.
- **A method folds open into a form with one field per argument**, built from that argument's type: a number input carrying the schema's bounds, a dropdown for a union of literals, a checkbox for a boolean, a picker for a date, a hex field for bytes, and for an object a JSON box pre-filled with the shape's required fields. Optional arguments have a checkbox deciding whether they are sent at all. Previously the whole call had to be written as one JSON array.
- JSON typed into a field is walked against the type before it is sent, so an ISO string where the schema says `date` becomes a `Date`. Without this any object carrying a timestamp was rejected by the server that asked for one.
- The browser waits longer than the console's own `--timeout`, which the console reports. Both defaulted to 10 s, so a call into an unreachable peer used to time out in the browser at the same moment the console was forming the answer that said why.
- Everything is bundled into `dist/web`; nothing is fetched at runtime.

## msgrpc 2.1.0

- `MethodSchema.paramNames` carries parameter names, and `msgrpc.describe()` reports them. Tooling that has to present a call to a person needs a label, and "argument 0" is not one. Optional and never used for checking, so a hand-written schema can leave it out. `msgrpc extract` writes it.

## msgrpc-cli 2.1.0

- `msgrpc console --sign <keyfile>` lets the console take part in a signed network. Without it the console lists peers, because presence is unsigned retained state, and then every call times out with nothing to say why. Keys come from a file rather than a flag, since a secret on a command line is visible to anyone who can run `ps`, and a `--name` contradicting the key file is refused rather than left to surface as that same timeout.
- README corrected: it claimed broker credentials and signing already applied to the console, which they did not, and documented none of the console's flags.

## msgrpc 2.0.1

- README rewritten. It documented 3 of 14 server options, described the MQTT v1 topic layout as current when MQTT 5 has been the default since 2.0.0, and its low-level examples wired converters that 2.0.0 removed. No code change.
- `repository.directory` and `homepage` added, so npm and GitHub can find each package in the tree.

## 2.0.0

A near-complete rework of everything below the API. The class-as-contract surface is unchanged — `exposeClassInstance` and `proxy<T>()` still look the same — but correlation, addressing, reconnection, security and the MQTT wire format were all rebuilt.

Published as `@source-repo/rpc` and, new in this release, `@source-repo/rpc-cli`.

### Breaking

| change | what to do |
| --- | --- |
| Output moved from `dist/src/*` to `dist/*`, with an `exports` map | Use the package name; deep imports into `dist/src` no longer resolve |
| ESM only, Node >= 18.17 | — |
| `RpcClient` extends `EventEmitter` | Only matters if you subclassed it |
| `ready()` throws after `readyTimeout` (default 30 s) instead of waiting forever | Catch it, or set `readyTimeout: 0` for the old behaviour |
| `RpcErrorPayload.exception` replaced by `error`, and error payloads carry `id` | The old field always encoded to `{}`; read `error.message` |
| `MqttTransport(name, url, options, sources)` — options are an object | `topic` and broker options move into it |
| MQTT defaults to protocol 5 on prefix `msgrpc/v2` | Set `protocol: 4` for the old `$`-header layout on `msgrpc/v1`; the two never share a topic |
| `manageRpc` is no longer exposed remotely | Set `exposeManagement: true` if you relied on remote `createRpcInstance` |
| Transports carry messages, not bytes; encoding lives in the transport | Only matters if you wrote a transport or wired the module chain by hand |
| `GenericModule.knownSources` static removed | Each `RpcServer`/`RpcClient` owns a `PeerRegistry` |
| `MessageSigner`/`MessageVerifier` take canonical bytes plus a context | One signer now serves both wire formats |
| An event is delivered only to the peer and namespace it came from | Previously every subscriber of that event name received it |
| `uuid` 14, `@types/node` 22 | — |

`exposeClassInstance(instance)` may now omit the name when the class declares `@rpcNamespace`.

### Security

Several of these were exploitable in 1.x. If you ran 1.x where untrusted peers could reach the transport, assume they were reachable.

- **Replies were broadcast to every connected socket.** An unauthenticated socket could read another client's payloads; clients merely filtered on arrival. Replies now go to one socket.
- **`ManageRpc` exposed itself**, so any peer could construct any `exposeClass`'d class with chosen arguments, or overwrite an exposed name and deny service to everyone else.
- **MQTT peer names were interpolated into topics unchecked.** A peer named `#` subscribed to every other peer's traffic. Names are now validated as a single topic level.
- Optional `authenticate` / `authorize`, with identity bound to the connection rather than looked up by a claimed name, so one peer cannot address messages as another.
- Optional frame signing (HMAC-SHA256 or Ed25519) with replay protection, which gives MQTT peers a verifiable identity without trusting the broker.

### Added

- **MQTT 5 frame layout** — reply address, correlation and method travel as packet properties, so a peer with no msgrpc code can take part and standard tooling can read the traffic. See `docs/mqtt5-frame-spec.md`.
- **Argument checking** against a schema, with `@rpc` marking which methods are exposed at all.
- **Contract versions**, compared structurally: a caller built against an older contract keeps working unless the two genuinely disagree.
- **`msgrpc.describe()`** reporting namespaces, methods, events and live instances. Off by default.
- **`@source-repo/rpc-cli`** — `extract` reads a contract from TypeScript source, `check` fails a build on a breaking change, `console` serves a browser view of a live network.
- MQTT shared subscriptions for server replicas, bounded sessions, and presence.
- Connection lifecycle events, configurable `callTimeout`, and fail-fast on disconnect.

### Fixed

- MsgPack round-tripped through JSON, turning every `Uint8Array` into `{"0":1,…}`.
- A server-side throw never rejected the caller; it timed out after 10 s with the error discarded.
- Pending-call bookkeeping never drained, leaking a timer per call.
- Repeated `on()` stacked a server-side listener each time and none could be removed.
- Clients did not re-subscribe after a reconnect, and servers never released a departed peer's subscriptions.
- `off()` was never handled by the server, so unsubscribing did nothing.
- Peer routing lived in one process-wide static, so two servers in a process could deliver each other's replies to the wrong client.
- `open()` ran twice per client, and `close()` left socket.io's reconnect timer armed.
- Browser builds pulled in the MQTT client whether or not they used it.
