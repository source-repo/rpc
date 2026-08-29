# Exact pause: what the mechanism can do, and what it costs

A feasibility prototype for the third phase of the [node live diagnostics design](source-rpc-node-live-diagnostics-design/source-rpc-node-live-diagnostics-design-spec.md), written before any breakpoint was built on it. The design's Phase 3 asks for an *isolated pausable TypeScript logic worker* and a *supported language/runtime pause gate*; whether this runtime can honestly provide either is a question better answered with a working gate than with a plan.

The gate is `RpcPauseGate` — written in `@source-repo/diagnostics` and since moved to `@source-repo/rpc`, which owns the execution it parks — and its tests run real worker threads because every claim here is about threads — a promise-based imitation would pass all of them and prove nothing. No breakpoint, no supervisor protocol, no controller lease, no stepping: `exactPause` and `stepping` are still advertised `false`, and this changes nothing a viewer can ask for.

## What it proves

`Atomics.wait` parks a worker's JavaScript thread in the kernel. The supervisor side uses `Atomics.waitAsync`, which returns a promise instead of parking. That asymmetry is the whole architecture, and the tests establish six things about it:

| Claim | How it is shown |
|---|---|
| The logic thread stops where it is asked to | The worker parks at its first gate and produces no answer while parked |
| The supervisor stays responsive | A timer on the supervisor's thread fires repeatedly while the component is stopped |
| **A resume continues the same stack** | The handler is entered once, parks once, and carries on — `['entry:released', 'clamped=300:ran-through', 'doubled=600:ran-through']`. Nothing before the gate ran twice |
| A parked thread reads nothing | A message posted to it while parked is not seen until it resumes, and is delivered afterwards |
| A lost controller cannot park a plant | With the supervisor doing nothing at all, the worker resumes on its own deadline and reports `expired` rather than `released` |
| The request/release race is closed | A release landing before the wait leaves the thread running rather than parked, by construction rather than by a lock |

The third row is the one that matters most, and it is what separates an exact breakpoint from re-running a handler and hoping it takes the same path. It is the design's second acceptance criterion, and it holds.

## What it costs

Measured on this machine, 50 million iterations, warmed:

| | per arrival |
|---|---|
| `Atomics.load` — the gate's fast path | **5.0 ns** |
| A plain `view[0]` read | 0.96 ns |
| Empty loop baseline | 0.36 ns |

So a gate on every statement costs about **5 ns per statement**: a twenty-statement handler pays ~100 ns, which is nothing beside the RPC that called it. A million-iteration loop with a gate in its body pays 5 ms, which is not nothing. Probe budgets should therefore be about *where* probes go, not only how many.

There is a cheaper variant that is worth knowing about and was not taken: a plain non-atomic read is five times faster, and the only thing it costs is that a pause request may be observed one gate late. That is a legitimate trade for a debugger — parking at the next statement rather than this one — but it should be chosen deliberately, not discovered.

## The limits, which are the point of building this first

**The pause scope is the worker, not the component.** A parked thread freezes everything on it: its timers, its socket callbacks, its promise continuations, and every other component sharing it. So either each pausable component gets its own worker — a node with fifty components paying fifty threads — or pausing one component stops its neighbours, which is a very different thing to advertise. The design's `PauseState` names a `componentId`, and this mechanism can only honour that with one component per worker.

**Deadlines do not pause, and the asymmetry cuts the wrong way.** A caller's TTL keeps running while the component is stopped, so a paused handler's caller times out normally — which the design already warns about. But timers *inside* the paused thread do not fire, so a watchdog the component holds is frozen exactly while the deadline it guards is not. A component that watches itself stops watching itself the moment it is paused.

**Requesting a pause is not stopping.** The thread parks at its *next gate*. A handler that reaches no further probe — blocking work, a tight loop without instrumentation, a call into something that does not return — cannot be paused at all. Nothing here can stop a thread between two statements it has already begun, and a debugger that implied otherwise would be lying about where execution is.

**A pause can land after an effect.** The design says this and it is worth restating with the mechanism in hand: parking after a state mutation or an external command cannot be undone, so an exact breakpoint inside a non-repeatable command handler is either prohibited or accepted with eyes open. The gate offers no rollback and no mechanism could.

**`SharedArrayBuffer` is not universally available.** Fine in Node. In a browser it requires cross-origin isolation, so a browser-hosted component could not use this gate — which matters for the console, though not for a plant node.

**The real cost is not in this package.** Today `RpcServer` holds the transport and its components on one thread. Making components pausable means moving component logic into workers and passing calls across a thread boundary — an architectural change to `@source-repo/rpc`, not to `@source-repo/diagnostics`. That, rather than the gate, is what exact pause actually costs, and it is why the design says exact pause is disabled by default for production and any hard real-time or plant-control path.

## What is left, and what it needs

Stepping needs no new mechanism, which is the good news. `step into`, `step over` and `step out` are the same gate with a predicate the worker evaluates: a logical frame depth maintained by the entry and exit probes that already exist, and a rule of the form *park at the next gate whose depth is ≤ d*. That is protocol on top of what is here, not another primitive.

What is genuinely unbuilt is the supervisor protocol around it — the controller lease with at most one holder, read-only observers of a pause, audited transfer, the pause-state publication, and the three expiry actions where only *resume* can be enforced by the parked thread itself. The other two need something alive to enforce them, which is precisely the case where the supervisor may not be.

If this is taken further, the honest order is: safe-boundary breakpoints first, since they need no worker at all and reach five of Phase 3's seven acceptance criteria on machinery that already exists; then the per-component worker model in `@source-repo/rpc`, which is the expensive part; then this gate behind it.

## What was built afterwards

All three, in that order. Safe-boundary breakpoints are `RpcPauseSupervisor` in `@source-repo/diagnostics`; the per-component worker model is `RpcWorkerHost` and `serveInWorker` in `@source-repo/rpc`, with this gate moved there beside them, since the package that owns execution should own the primitive that parks it.

The estimate above was wrong in one direction worth recording: **the expensive part turned out not to be the worker either.** The seam is `handler(...params)` and nothing else — everything the server does before that call is policy about a *call* and belongs on the thread calls arrive on, so a worker-hosted instance is exposed through the ordinary path and the dispatch code was never touched. What the work actually consisted of was the boundary's honesty: arguments and results crossing by structured clone, an exception crossing as message-name-code, and the `@rpc` declarations having to be carried across explicitly — because a forwarding object built at runtime never saw a decorator, and a `non-repeatable-command` silently becoming an undeclared method would have been a safety regression caused by a change of hosting.

The limits above all held. One instance per worker is now enforced by the shape rather than recommended, and a handler that reaches no gate still cannot be paused inside — it parks at the boundary before the call instead, which is a safe-boundary pause arrived at from the other direction.
