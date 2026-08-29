# @source-repo/diagnostics

Live values beside the source that declares them: the oldest way of looking at a machine, without a debugger and without instrumentation.

```
npm install @source-repo/diagnostics
```

- **No second data path** — this serves file names, hashes and positions; the values come from the component channel the viewer already had, through the permission check that was always there.
- **A build-time catalogue** — `source-rpc extract --bindings` records where each `props` and `state` path is declared, from the same resolved types the contract came from.
- **Nothing is drawn on the wrong source** — a value positioned by a line from an edited file is worse than no value, so the revision and the file hash are compared first, and the refusal is a sentence rather than a boolean.
- **Capabilities are advertised, including the ones that are false** — a viewer that finds `exactPause` absent cannot tell "this node cannot" from "this protocol version had not thought of it".
- **The node's own diagnostics are a component** — capabilities and the running revision are props, so a redeploy reaches every open editor without polling.
- **A sensitive field says so beside its declaration**, and a viewer draws a marker rather than the value.
- **A diagnostic variant can be proved to be one** — strip the recognised probes, reprint, and compare against the approved program, because a build cannot be trusted to report on itself. The node compares hashes; the compiler does the walk.
- **What counts as a probe is defined by the verifier** — a fixed set of shapes on a reserved receiver, and anything else that mentions it is a refusal rather than something to strip; a strip that guessed would be deciding for itself what the program was meant to be.
- **A viewport becomes the containing function** — line ranges begin in the middle of conditions, and a plan built per scroll position would rebuild the variant while somebody reads. Spans in the plan are spans of the approved source, since that is the file on screen.
- **Unavailable rather than uncertain** — an initialiser holding a function body, or a branch that would need braces, is reported with its reason instead of transformed on a guess. Exactly-once evaluation and short-circuiting are tested by running the instrumented code, not by comparing syntax trees.
- **Activation is the ordinary handoff** — the variant goes in over `@source-repo/continuity`'s `handOver`: shadow with output fenced, barrier, capture, restore without migration, atomic epoch swap. Instrumenting a component is not a special way of replacing it; it is replacing it with something proved to be the same program.
- **Proved before the plant is touched** — an inadmissible variant is refused while the base activation is still running, so the component is never quiesced for a build that could never be activated.
- **A probe cannot become the fault** — the sink never throws into component logic, returns the observed value by identity, is bounded with its drops visible, and never awaits or reaches the network, the filesystem or the plant.
- **Capabilities are derived from what the host wired** — `diagnosticVariants` when a deployment has a store, fences and a coordinator; the probe flags when there is a sink *and* an authoriser. Two nodes on the same build can honestly answer differently.
- **Twelve diagnostics permissions, checked one at a time** — seeing props is not seeing locals, and seeing locals is not being allowed to change the artifact. A caller holding some of them gets a degraded session naming what it did not get; a session that could serve nothing is refused, because falling back to nothing is not a fallback.
- **A table, not an event per hit** — the latest value per probe and its execution count go in state, sized by how many probes there are rather than how often they fire, with the dropped count published beside them. An ordered trace is an event, and only for a session permitted to keep a recording.
- **A classified field is withheld at capture** — not in the editor, because a value redacted on its way to a screen has already been in a buffer and a message. The probe still fires and is still counted.
- **A session has a deadline** — clamped by the node, because a disconnect looks like a slow viewer, and something has to stop a plant being left instrumented when somebody closes a laptop.
- **A tracepoint captures without stopping** — its condition is compiled into the verified derivative and checked against a constrained grammar first: comparisons and logical operators, no calls, no assignments. A condition runs inside the component, so `queue.pop() > 3` would empty a queue to decide whether to mention it — and the stripped program would still be identical, which is why the grammar is the only place that catches it.
- **Counting and capturing are different** — every hit is counted whether the condition held or not, because *this line ran four thousand times and never matched* is an answer and a silent probe is not.
- **A safe-boundary breakpoint stops between units of work** — the probe asks, the running handler finishes under ordinary semantics, and the component stops before its next call. It is a tracepoint whose policy says stop, so switching one on needs no rebuild. Work that arrives queues in order behind the barrier; resuming needs a controller lease held by one session at a time; a pause nobody ends is ended by its declared expiry action.
- **A pause gate exists, and an exact breakpoint does not** — `RpcPauseGate` parks a worker's thread in the kernel while the supervisor keeps answering, and a resume continues the same stack rather than re-running the handler. It is the mechanism measured on its own; `exactPause` and `stepping` are still `false`, because a mechanism is not a feature.

Full documentation: the [package README](https://github.com/source-repo/rpc/blob/main/packages/diagnostics/README.md). On npm: [@source-repo/diagnostics](https://www.npmjs.com/package/@source-repo/diagnostics).
