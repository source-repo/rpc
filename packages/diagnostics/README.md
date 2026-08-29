# @source-repo/diagnostics

Live values beside the source that declares them, for a [Source RPC](https://github.com/source-repo/rpc) node. The oldest way of looking at a machine — the program on screen with what each thing currently is written next to it — without a debugger, without instrumentation, and without a second data path.

**Phases 1 to 3 of the node diagnostics design.** Source-linked props and state; a diagnostic variant that can be proved a derivative, generated, and swapped in over a state-preserving handoff; and a bounded sink for what its probes see. Tracepoints capture without stopping, safe-boundary breakpoints stop between units of work, and an exact breakpoint stops on the line — the last of those needing the component's logic on a thread of its own. Stepping is advertised as `false` rather than left out.

## The whole economy of it

Props and state are **already observable**. A subscriber receives them, `authorize()` has already ruled on them, a projection has already narrowed them. So the only thing missing from a PLC-style live view is *where each one is declared* — and that is static, known at build time, and costs the running artifact nothing.

Which makes the design's third acceptance criterion — that a user cannot obtain a field through source view that they could not obtain through ordinary authorised observation — a fact about the architecture rather than a check somebody has to remember to write. **There is no second data path to secure, because there is no second data path.** This package serves file names, hashes and positions; the values come from the component channel the viewer already had.

## Building the catalogue

```
source-rpc extract --project tsconfig.json --out contract.json --bindings bindings.json
```

The same walk that produced the contract, from the same resolved types — so the paths a viewer overlays and the paths the contract publishes cannot be two different answers. It descends through objects and stops at records and arrays: a record's keys are data, so `tags` has a declaration and `tags['tag.007']` does not, and inventing a span for it would put a value beside a line that says nothing about it.

## Serving it

```typescript
import { exposeDiagnostics } from '@source-repo/diagnostics'

exposeDiagnostics(server, {
    catalogue: JSON.parse(readFileSync('bindings.json', 'utf8')),
    // Omit it and the node serves bindings and identity but no text. That is the right default for
    // a plant: where a value is declared and the source itself are different disclosures with
    // different audiences, and a viewer with its own checkout needs only the first.
    sourceRoot: 'src'
})
```

**It is a component**, because the design says so in the shape of its own contract: the illustrative `NodeDiagnostics` has `capabilities` and `activeSource` as readonly *properties*, and a readonly property a viewer watches is what an observable component already is here. So they are props — a viewer subscribes, and a redeploy that changes the running revision reaches every open editor without anybody polling for it.

`source()` is a separate method because it is a separate permission: a viewer may legitimately be allowed to know that `state.setpoint` is declared at line 34 and not be allowed to read the file that says so.

## Nothing is drawn on the wrong source

```typescript
const refusal = overlayRefusal(catalogue, identity, { fileId, contentHash })
if (refusal) return showTheFileWithoutValues(refusal)
```

A value positioned by a line number from a file that has since been edited is worse than no value: it is a number somebody will act on, sitting beside a declaration that is no longer the one it came from. So the comparison happens first, and it answers with a **sentence** rather than a boolean — three different problems live here, and a viewer that said "false" to all of them would leave a person guessing:

- the file on screen has been edited since the build
- the node has been redeployed and is running a revision this catalogue does not describe
- the file was never part of this build at all

## Sensitivity

A binding may carry a `sensitivity`, and a viewer draws a marker instead of a value. Read-only visibility is not harmless — a value can be a credential, a production quantity or somebody's name — and the classification belongs beside the declaration because that is where the person who knows is.

## A diagnostic variant can be proved to be one, which is not building one

Generating probes into the node's own source and running the result is a licence to put *different code* on a plant in order to watch the code that was approved, and the whole design rests on one claim: **the variant differs from the approved revision in probes and nothing else.**

Nothing about a build checks that. A transformer with a bug, a hand-edited artifact and a deliberately altered one all produce a file that compiles and runs. So the check is the reverse operation — strip every recognised probe and see whether what is left is the approved program — and it is the reverse operation precisely because it does not trust the forward one.

```typescript
const proof = await provesDerivative(base, variant, 'oven.ts', 'rev-7')   // in @source-repo/rpc-cli
const refusal = await admissibleVariant(manifest, approved, {
    baseSemanticDigest: proof.baseSemanticDigest,
    strippedSemanticDigest: proof.strippedSemanticDigest,
    plan,                                                    // what a reviewer approved and a viewer is served
    found: proof.probes.map(({ probeId, kind }) => ({ probeId, kind })),   // what the artifact carries
    addedCapabilities: []
})
```

**The node holds hashes and compares them; the compiler does the walk.** `admissibleVariant` runs the rules and refuses on the first, each in its own sentence because they are separate conversations: source that has moved on, a base artifact that is not the one running, a stripped variant that is not the base, a changed contract, a changed persistent state schema, changed non-diagnostic capabilities, and a plan that does not match the artifact. The only capability a variant may add is `diagnostics.telemetry` — anything else is an artifact using instrumentation to widen its own authority.

**The plan and the artifact are two different lists on purpose.** The plan's spans are spans of the approved source, because that is the file a viewer is reading; the strip reports what is compiled in, by identity and kind. Neither can be derived from the other, and comparing them is the check: a probe in the artifact that no plan names is an observation point nobody reviewed, and a plan naming a probe the artifact lacks is an overlay that will never fire while looking exactly like one that has not been reached yet.

**What counts as a probe is defined by the verifier, not by the generator.** A probe is a call on the reserved receiver `__rpcProbe` in one of seven recognised shapes; anything else mentioning that name is a refusal rather than something to strip. The wrapping forms — `value` and `condition` — take the observed expression as an argument and evaluate to it, so it appears exactly once and "evaluated exactly once, with unchanged results and exception behaviour" is a property of the shape rather than a promise about a generator. A strip that skipped what it did not recognise would leave it in the output and report *the transformer changed the program*, which is true and points at the wrong thing; one that deleted anything mentioning the receiver would delete code somebody wrote.

Programs are compared reprinted from their parse trees, so two files differing only in where the newlines fall are the same program and **comments are not part of the comparison** — a probe legitimately arrives with one attached. The cost is real and worth naming: a variant may change a comment and this will not see it. What it exists to catch is a changed program, and a comment cannot be one.

`diagnosticVariants` stays `false` in the advertised capabilities. Verification is not activation, and a flag that ran ahead of the code would be the one thing the capability set exists to prevent.

## Generating the probes the verifier accepts

`instrumentSource` in `@source-repo/rpc-cli` is the other half, and it was written second on purpose — a transformer that also defined what counted as correct would be marking its own homework. Every test it has ends by handing its output to `provesDerivative`.

```typescript
const instrumented = instrumentSource(source, 'oven.ts', 'rev-7', [{ from: 40, to: 60 }])
```

**A viewport is expanded to the containing function**, which is the design's default unit and not a convenience. A viewport begins in the middle of a condition as often as not, and instrumenting from there would put an entry probe inside an expression. It also makes the result stable while somebody scrolls: a plan built for a function does not change because two more of its lines came into view, so the variant already running stays the right one, and two viewports over one function are one region.

**Spans in the plan are spans of the approved source**, recorded before emit, because the person reading is looking at the approved file and not at the instrumented copy. Probe ids are derived from those positions rather than counted, so the same source produces the same plan however the walk reached it — and they are not stable across revisions, because a position is exactly what an edit moves.

**Unavailable rather than uncertain.** A missing probe is a screen with one fewer value on it; a transform that was nearly equivalent is a plant running code nobody approved. So an initialiser holding a function body is reported rather than wrapped — the arrow inside it is instrumented as its own region, and a probe around it would have to be rewritten as another probe rewrote its inside — and a single-statement `if` branch is reported rather than given braces, because adding braces is a change to the program even where it reads as the same one. Loops and `try` bodies are probed as the statements they are: a coverage limit, stated, not an equivalence risk.

The invariants that matter are tested by **running** the instrumented code against a recording stub, because "evaluated exactly once" and "short-circuit preserved" are claims about execution that no comparison of syntax trees can check. Conditions are wrapped whole and never by operand, so `a && b` short-circuits exactly as it did. Returns are found by their own scan at every depth, so entry and exit pair up even when the return is inside a block, a loop or a `try` — otherwise an overlay shows a function that was entered and never left.

## Swapping the instrumented copy in, and taking it back out

Instrumenting a component is not a special way of replacing it. It is the ordinary way of replacing it with something that was proved to be the same program — so activation is `@source-repo/continuity`'s `handOver`, and the design's section 16 maps onto it step for step: shadow with output fenced, quiescence barrier, capture, restore the identical state schema without migration, re-establish obligations, atomic epoch swap.

```typescript
const outcome = await activateDiagnosticVariant({
    manifest, approved, evidence,
    obligations: runtime.manifest(),      // what the incumbent is holding, read before preparing
    timerPolicy: 'preserve-deadline',
    handoff                               // fences, buffer, capture, restore: the caller's
})
```

**The variant is proved admissible before the plant is touched at all**, which is why the design says to validate while the base activation is still running. A variant that could never be activated costs nothing — the component is never quiesced for it. A handoff refused at the barrier has already stopped a plant.

**This is the one handoff where blanket `assumed` is a conclusion rather than an assumption.** Everywhere else a successor that says nothing about an obligation is refused, because a different revision cannot be presumed to know what `mix-dwell` was for. Here the successor was *proved* to be the same program plus probes, so it knows every obligation by the same id, and `declarationsForVariant` reports that proof rather than hoping. What no proof can settle is what a timer should do about the handoff window — so the policy is still asked for, by name, from somebody who knows what the timer is for.

An obligation the component took on *after* preparation is deliberately not covered: `planRestore` re-runs against the snapshot actually captured and refuses on anything undeclared. A paused activation is refused too — it is not quiescent, so it cannot reach a barrier — and that rule is encoded now, before anything can pause, rather than discovered when the first breakpoint exists and a handoff hangs.

Removal is the same protocol run the other way. The check that differs is which artifact is arriving: going in, a variant must be proved a derivative of what is running; coming out, what returns must be the approved artifact itself.

## Where a probe writes

A variant imports `__rpcProbe`, and `RpcProbeSink` is what that is. It is deliberately dull, because it runs on a plant between statements that control machinery:

- **Never throws into component logic.** Every entry point swallows its own failures. A probe that threw would turn watching a component into breaking one, in the handler somebody was watching precisely because it was already going wrong.
- **Returns the observed value by identity**, which is what makes probes removable and the program the program.
- **Bounded**: a ring of samples and a byte cap on every rendered value, with `dropped` visible — a viewer that cannot see what was dropped cannot trust the trace. A component in a hot loop must not be able to fill a node's memory by being watched.
- **Never awaits, never reaches the network, the filesystem or the plant.** A value is rendered at capture rather than held, so nothing stays alive because it was once observed, and a getter that throws becomes `unrepresentable` rather than an exception on the component's stack.

## What a node advertises, and why it is derived

`capabilitiesFor` reads what the host actually wired. `diagnosticVariants` is true when a deployment has given the node an ownership store, fences and a coordinator; the probe flags are true when there is a sink for probes to write to, because generating a value probe is not the same as being able to say what it saw. Two nodes running this same package can honestly answer differently, and a package that guessed would advertise something the deployment never arranged.

Still `false`, and not by oversight: `tracepoints` — a tracepoint is a probe with a condition and a message, and neither exists — along with `safeBoundaryPause`, `exactPause` and `stepping`, which are the phase after.

## Who may watch, and for how long

Serving probe samples *is* a second data path, in a way the source catalogue never was: locals are not otherwise observable. So it arrives with the authority model rather than as a convenience method.

```typescript
exposeDiagnostics(server, {
    catalogue,
    sink: new RpcProbeSink({ maxSamples: 2000, maxValueBytes: 512, withheld }),
    authorise: (permission, caller) => grantsOf(caller).includes(permission)
})
```

**The sink and the authoriser go together, and neither is enough alone.** A node given only one of them serves no sessions and advertises no probe capabilities — there is no default, because a package cannot decide on a deployment's behalf that watching a component's locals needs no permission.

**Diagnostics permissions are their own set**, twelve of them, because they are twelve different conversations. Being allowed to see a component's props is not being allowed to see its locals; seeing locals is not being allowed to *change the artifact* by activating an instrumented build; and watching a value is not `retain-recordings`, which is what an ordered trace actually asks for — watching is transient and a trace is a copy.

They are checked one at a time, and the result is a **degraded session rather than a refusal**: a caller who may watch values but not execution paths gets `live-values`, and `execution-hits` comes back in `degraded` with the reason. Same for a mode this node cannot serve at all. What is refused outright is a session that could serve *nothing* — falling back to nothing is not a fallback, and a session reporting itself healthy while showing an empty screen is indistinguishable from a component that has not run yet.

A session carries a deadline, clamped to what the node allows, because a disconnect is not distinguishable from a slow viewer at this level. The deadline is what stops a plant being left instrumented because somebody closed a laptop. An update may move the viewport and renew the deadline; it may not widen the modes, which were decided against this caller's permissions when the session started.

## How what was seen gets out

Probes write to the sink and return. The service reads it on its own schedule — `publish()` is called by the host, not by a timer in here, because a package that started its own interval would be setting a plant's publication rate from a library.

- **Props** carry what a session *is*: the modes granted, what was degraded and why, the revision it belongs to. A viewer subscribes and is told.
- **State** carries how it is *doing*: the latest value per probe, execution counts, health, and the dropped count — published beside the values, because a gap a viewer cannot see is a lie.
- **Events** carry an ordered trace chunk, and only to a session that asked for one and was allowed to keep it.

**A table, not an event per hit.** A statement in a loop at a hundred hertz produces six thousand events a minute and one useful fact. The table is sized by how many probes there are, never by how often they fire, so watching a hot function costs what watching a cold one costs.

**A classified field is withheld at capture, not in the editor.** A value redacted on its way to a screen has already been in a buffer, in a message, and in whatever logged either. A probe on a withheld field still fires and is still counted — the execution path stays visible — and the value never enters the process's diagnostic memory at all.

## Tracepoints: capture without stopping

A tracepoint captures selected locals when a condition holds and emits an event, without stopping the component. It is the mode appropriate to the widest range of nodes, and the only one of the three this package implements — the other two stop a plant.

```typescript
instrumentSource(source, 'oven.ts', 'rev-7', viewports, {
    tracepoints: [{ line: 12, condition: 'clamped > 200', captureSymbols: ['clamped', 'target'], messageTemplate: 'clamped to {clamped} from {target}' }]
})
```

**The condition is compiled into the verified derivative and checked against a constrained grammar first**, which is the design's rule that conditions may not use unrestricted runtime evaluation. Comparisons, logical operators, property access, literals — no calls, no assignments, no increments.

That check is not fussiness, and it is not something the derivative proof can do instead. A condition runs *inside the component*, on its stack, between its statements: `queue.pop() > 3` would empty a queue in order to decide whether to mention it. Strip the probe afterwards and the program is identical, so the proof passes and the plant has still been running something nobody approved. The grammar is the only place that catches it, so it catches it at build time, where a person can be told which expression and why. Every identifier must also be one of the captured locals — a condition cannot reach a global, and a capture list is not a way to read one.

**Counting and capturing are different.** Every hit is counted whether the condition held or not, because *this line ran four thousand times and never matched* is an answer, and a probe that recorded nothing when it did not capture would be indistinguishable from a line that was never reached.

What the sink decides — how many hits to skip, what the message reads as — needs no rebuild, because none of it runs inside the component. Changing the condition does, and that is the design's split. A `{placeholder}` naming something that was not captured is left as written rather than becoming `undefined`, and a withheld field renders as its marker in the message too: a template is not a way around a classification.

Captures are bounded and what the bound discarded is counted, like everything else here. They reach the session that installed the tracepoint and no other, because a capture is a value somebody was separately permitted to take.

## Stopping between units of work

A safe-boundary breakpoint is a tracepoint whose policy says stop. **No rebuild** — that is the design's own rule: *adding an unconditional stop policy to an existing probe does not require rebuilding the variant*, so turning a tracepoint into a breakpoint costs a map entry rather than a swap of the code running on a plant.

```typescript
const pauses = new RpcPauseSupervisor({
    componentId: 'oven3', semanticRevisionId: 'rev-7', activationEpoch,
    hold: () => server.rpc.holdExecution('oven'),   // the barrier that already exists
    expiryAction: 'resume',
    maxPauseMs: 60_000
})
const sink = new RpcProbeSink({ tracepoints: { [probeId]: { stop: true } }, onStop: (probeId) => void pauses.requested(probeId) })
```

**Nothing is interrupted.** The probe fires, records, and asks; the handler that was running **runs to its end under ordinary semantics**; the component stops before accepting its next unit of work. That is what makes this mode survivable by a component that was halfway through commanding something — an exact pause can land after a valve has moved, and this one cannot land anywhere except between two whole pieces of work.

A viewer must say which pause this is, and `kind: 'safe-boundary'` is on the state so it never has to infer: execution stopped *after* the handler, not on the line the probe is drawn beside. A caret on that line would be putting the component where it is not.

**Work that arrives while paused queues**, in order, bounded by the instance's mailbox, and a caller beyond that bound is refused `Busy` by the machinery that always refuses it. That is `buffer-bounded`, and it is inherited rather than implemented. The design's other two incoming-work policies would need the server to answer differently while paused — a change to the call path rather than a policy on top of it — so they are named and reported unsupported rather than approximated.

**Resuming needs the lease.** One controller at a time, because two debuggers issuing continue at one stopped plant is two people deciding the same thing without knowing about each other; everyone else authorised may still watch, since reading is not controlling. Transfer is explicit and recorded. Control answers to `control-paused-activation` — being allowed to see where a component stopped is not being allowed to start it again — and continue is a `non-repeatable-command`, because a retry arriving after a resume would be asking to resume a component that has since stopped again for a different reason.

**A pause nobody ends is ended by its deadline**, and the declared expiry action is chosen before it matters: `resume` lets it go, `stopped` keeps it stopped and stops pretending anybody owns it, and `terminate` ends the diagnostic activation — which needs something to terminate with, so a supervisor configured that way with nothing supplied is refused at construction rather than at the moment it was needed.

Nothing here retries anything. A command that arrived while the component was stopped runs exactly once when it is let go, and its caller's ordinary timeout and `UnknownOutcome` behaviour is untouched.

## Stopping on a line

The same supervisor, handed a different mechanism. Given a barrier it can only stop what has not started; given the gate of a component hosted on its own thread it stops the logic **between two statements of a handler**.

```typescript
const host = new RpcWorkerHost({ module: './oven.worker.js' })          // @source-repo/rpc
const pauses = new RpcPauseSupervisor({ ...identity, gate: host.gate, expiryAction: 'resume' })
```

**Exactly one mechanism, and the kind of pause follows from it.** A supervisor given both would be one that could claim either kind while producing the other, so it is refused at construction — the design requires the two to be clearly distinguished, and the surest way is to make claiming the wrong one impossible rather than incorrect. `exactPause` is advertised from the mechanism for the same reason: a node cannot offer a control that produces something else.

Everything around the stop is unchanged, which is the point. The lease still governs a resume, the deadline still ends a pause nobody ended, and the probe that asked does not know which mechanism is underneath. What differs is where the component is when it stops, and `kind` on the pause state says which.

**Two limits worth holding on to.** A request only affects gates reached *after* it lands — asking after a call has already gone out is a race with another thread, and a handler that reaches no further gate parks at the boundary before its next call instead, which is a safe-boundary stop arrived at from the other direction. And a request that does not park within its wait is **withdrawn**, because a component that parked ten minutes later with nobody watching would be worse than one that never stopped.

## Stepping

The design's five commands, each one predicate over a frame depth the entry and exit probes maintain. No new mechanism — the gate was always able to do this; what was missing was the arithmetic.

```typescript
await pauses.step(leaseId, 'over')                                  // run the call, land on the next line
await pauses.step(leaseId, 'run-to-probe', host.indexOfProbe(id))   // run to a cursor
```

| | where it lands |
|---|---|
| `into` | the very next point there is — which is the same predicate as a breakpoint's, because stepping into *is* stopping at the next place there is to stop |
| `over` | shallower than here, or the same frame and not an exit — so a call runs to its end, and stepping over the last statement still lands on the function's exit |
| `out` | shallower than here — the current frame's exit |
| `run-to-probe` | the probe named, **by index** |
| `continue` | nowhere: it means *run until something else stops you*, so there is nothing to wait for |

**A cursor is an index, and that is forced rather than chosen.** A step command reaches a *parked* thread, so it cannot arrive as a message — a parked thread does not read its queue. It travels through shared memory, and shared memory holds integers. Matching on a hash of the probe's name would mean stopping at the wrong line on a collision, so both sides hold the same registry and a probe the artifact does not carry is refused rather than resolved to the nearest thing.

**Every step is a resume**, so every step is the lease holder's to issue and none of them is silently repeatable. A step that meets no further gate leaves the component running rather than paused — a step off the end of a program is where the program ends, not a failure to stop.

Two waits had to be got right, and both were wrong first. The pause state names **where it stopped**, read from the gate rather than carried forward from the probe that asked — otherwise a stepping viewer draws its caret one step behind the truth. And a step waits for the **next park by count**, not for the logic to be seen running and then parked: between two adjacent gates the logic parks again before this side observes it leaving, so the obvious wait times out on a component that is stepping perfectly.

## Stopping a component, and what that would cost

`RpcPauseGate` is the mechanism an exact breakpoint would be built on, built and measured on its own before anything was built on top of it. **It is not a breakpoint**: there is no supervisor protocol, no controller lease and no stepping, so `exactPause` and `stepping` stay `false` and nothing a viewer can ask for has changed.

`Atomics.wait` parks a worker's JavaScript thread in the kernel — not a promise that resolves later, the thread itself — which is what "the component logic execution context is blocked" has to mean. The supervisor side uses `Atomics.waitAsync` instead, so the process holding the component keeps answering while the component is stopped; a supervisor that blocked to wait for a pause would have suspended the only thing capable of ending it.

The property worth having is that **a resume continues the same stack**. The gate returns into the middle of the handler it stopped: the next statement is next, the locals are the locals, and nothing has been re-executed. That is what separates an exact breakpoint from re-running a handler and hoping it takes the same path.

A pause nobody ends ends itself, on the parked thread's own deadline, because the case that matters is the one where the supervisor is gone. Richer expiry policies need something alive to apply them.

The fast path is one `Atomics.load` — about 5 ns per arrival, against 1 ns for a plain read. Twenty statements cost 100 ns; a million-iteration loop with a gate in it costs 5 ms.

[The full findings](https://github.com/source-repo/rpc/blob/main/notes/exact-pause-feasibility.md), including the limit that shapes the phase: a parked thread freezes *everything* sharing it, so a pause scope of one component means a worker per component — and the expensive part is not this gate but moving component logic off the transport's thread.

## License

MIT
