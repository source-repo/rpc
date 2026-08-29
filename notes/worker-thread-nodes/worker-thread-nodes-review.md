Source RPC supports worker-hosted handler logic, but not yet a complete worker-hosted peer/node.

The current `main` branch (`39de1b8`) puts [`RpcWorkerHost`](https://github.com/source-repo/rpc/blob/39de1b86a4780cdc578c5842d623575969e62a86/packages/rpc/src/RPC/WorkerHost.ts#L5-L35) and [`serveInWorker`](https://github.com/source-repo/rpc/blob/39de1b86a4780cdc578c5842d623575969e62a86/packages/rpc/src/RPC/WorkerRuntime.ts#L84-L148) in `@source-repo/rpc`, not diagnostics. Diagnostics motivated the feature and is its first consumer, but the mechanism is general:

* The supervisor retains transport, authorization, deadlines, ownership fencing, queuing and idempotency.
* Only `handler(...params)` crosses into the worker.
* Arguments and results use `postMessage`/structured clone.
* Mutable instance state stays inside the worker.
* Calls are serialized in arrival order.
* One instance occupies one worker, because pausing that thread freezes everything on it.

So I would cross the worker-thread bridge. I would not cross the implicit shared-mutable-state bridge.

| Meaning of “worker node”                                               | Current state                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Methods of an exposed instance run in a worker                         | Already implemented                                                          |
| Full `RpcComponent` with props, state, snapshots, events and authority | Partial; needs a host-side facade                                            |
| Independent RPC peer in a worker, with presence and routing            | Not implemented; would need a `MessagePort` transport and lifecycle handling |

The second row is the important gap. `callable()` currently creates a plain forwarding object. It is not an `RpcComponent`, while the server installs snapshot publication and accepts `sets`/`requiresAuthority` only for actual `RpcComponent` instances ([exposure code](https://github.com/source-repo/rpc/blob/39de1b86a4780cdc578c5842d623575969e62a86/packages/rpc/src/RPC/RpcServerHandler.ts#L1800-L1853)). Events and invocation injection also do not cross the present worker protocol. Thus this is excellent handler hosting, but not yet placement-transparent node hosting.

I think the natural next abstraction is a `RpcWorkerComponentFacade`:

* The supervisor-side facade owns identity, security, authority and the last published snapshot.
* The worker owns executable logic and private mutable domain state.
* State commits and events return as versioned messages and are cached/published by the facade.
* While the worker is paused, the console can still inspect the last snapshot and the supervisor remains responsive.

That fits the existing architecture better than immediately putting an entire `RpcServer` in every worker.

There is also one concrete boundary issue to fix. The code currently relies on `postMessage` throwing for values that cannot cross. That catches functions, but:

* Class instances are silently flattened into plain objects.
* `SharedArrayBuffer` crosses with genuinely shared backing memory.
* Structured clone accepts values that MessagePack/JSON may represent differently.

So the comment promises a stricter boundary than the implementation currently enforces. Before making worker placement general, I would introduce one canonical `RpcValue` validator used by all local boundaries. It should reject non-portable prototypes, cycles and shared buffers unless explicitly allowed.

The placement model could then be:

| Placement             | Data boundary                  | Domain state          |
| --------------------- | ------------------------------ | --------------------- |
| Same-thread peer      | Validate and deep-clone        | Owned by that peer    |
| Worker peer/component | Validate plus structured clone | Owned by the worker   |
| Process/remote peer   | Validate plus codec            | Owned by that process |

That preserves your “null codec” idea: null encoding, but not an identity boundary. Same-thread calls should still clone so moving a node into a worker does not suddenly change its correctness.

Shared memory should remain a named capability outside the ordinary data plane. [`RpcPauseGate`](https://github.com/source-repo/rpc/blob/39de1b86a4780cdc578c5842d623575969e62a86/packages/rpc/src/RPC/PauseGate.ts#L53-L75) is exactly the right pattern: twelve explicitly structured bytes with one synchronization purpose. A high-rate sample ring buffer might justify another such capability. Raw shared props/state would not—it would introduce races, bypass snapshots and auditing, and make deployment placement observable.

Finally, workers should be reserved for active logic needing pause, CPU or event-loop isolation. Thousands of virtual or informational nodes should remain lightweight resources hosted by a component, not become thousands of workers. And workers are not a security sandbox; untrusted plugin code still belongs in a separate process or stronger isolation.

So: worker support is a good and already partly completed direction. The architectural rule should be **private state by default, copied messages between nodes, explicit shared-memory primitives only where their concurrency protocol is itself part of the contract**.


---

## What was done about this

**The boundary check is built** — `RpcValue` in `@source-repo/rpc`, wired into both directions of the worker seam, with the fixture gaining a method that returns one of its own class instances so the case that used to succeed and arrive gutted is now a test.

The rule is the review's principle taken literally: **the narrowest placement decides**. A `Date` and a `Map` are refused although a worker would carry them, because a remote peer receives a string and an empty object; a `bigint` is refused with the decimal-string convention this library already uses for positions; binary passes, because the frame codec carries it either way. A cycle is refused for exactly the stated reason — structured clone takes it and no codec does, so a component holding one would work until it moved.

One case is named and deliberately not policed: `undefined` as an object's property value, which JSON drops and MsgPack keeps. An options object with an absent field is the most ordinary value in this codebase, and refusing it would cost more than the difference does. Saying which cases a validator ignores seemed better than a validator that quietly ignores one.

**Not done, and disagreed with as stated:** *"same-thread calls should still clone so moving a node into a worker does not suddenly change its correctness."* The principle is right and the remedy is expensive — a deep clone on every in-process call, on the path this library exists to make fast. What is built instead is the check, which catches the same class of mistake at the same place without the copy. If a caller mutates an argument after passing it in-process, that difference remains; making it impossible costs the clone, and that is a decision worth taking deliberately rather than as a side effect of this.

**And the facade is built.** `serveComponentInWorker` and `RpcWorkerHost.component()`, dividing ownership exactly as proposed: the worker holds executable logic and private mutable state, and the supervisor holds identity, security, authority and the last published snapshot. Commits arrive through `installComponentPublisher`, which already carried a throttle and a byte bound, so the worker-to-supervisor hop inherits the deployment's existing limits rather than being given new ones. Events cross as name and arguments, checked by `RpcValue` and **thrown at the emit site** when they cannot: stricter than an in-process component, which would fail later and further away at a subscriber that received nothing.

The predicted consequence holds and was worth having: while the worker is parked at a breakpoint, the supervisor answers and a console reads the last published snapshot.

One limit came out of testing it, and it is the mechanism rather than an omission: **a parked thread cannot publish**. The publisher runs on a microtask and `Atomics.wait` freezes the thread that would run it, so a commit made after the last publication and before the park is invisible until the component resumes. What a console sees while a component is stopped is what that component had *published*, not what it had *done*. Publishing synchronously on every commit would close the gap and would give up the throttle; that trade is available and was not taken.

**And the third row is built.** `MessagePortTransport`: a whole `RpcServer` on a worker thread, with a name, a presence and a route, answering calls addressed to it and originating calls of its own to peers it learned about when the link opened.

Symmetric, because a `MessageChannel` has two ends and no broker — so one class serves both, each announcing itself and recording the other. Presence is that announcement plus a `peerGone` when the port closes, which a terminated worker does produce; `carrying` is what lets the host advertise the rest of the network so a worker peer can call outward through it.

**The null codec turned out to be sharper than expected.** Frames are projected to the same flat wire shape every other transport sends, and then posted — no MsgPack, no `$` to find, no header to walk. The projection is not a formality: the library's `Message` is a class, and sending one directly is exactly the mistake `RpcValue` exists to catch. This transport's own check caught it on the first run, which is a pleasing way to find out the rule was worth writing.

So the placement table you proposed is now real at all three rows, and the same value is legal at each.
