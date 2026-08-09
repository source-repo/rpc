# Returning a long job's result to the caller that asked for it

A proposal against `source-repo/rpc`, covering namespace withdrawal, deferred replies, and two smaller fixes found along the way.

## The use case

A caller starts work that takes longer than any sane call deadline — a report, a scan, a batch import. The result belongs to the peer that asked, and to nobody else. Today the library has no shape for this, and each of the three workarounds gives up something the library otherwise insists on.

**Events broadcast.** An exposed `EventEmitter` delivers to every subscription taken out on that peer and namespace. Subscriptions are keyed per caller so the server can route and clean them up, but `emit` fans out to all of them. There is no targeted emit. Correlating with a job id in the payload works and leaks every job's result to every subscriber.

**A per-job instance isolates correctly and never goes away.** One namespace per job is one subscription surface per job, so the isolation is exact, and each job gets its own mailbox, so a slow job cannot queue up behind another's commands. But `exposeClassInstance` writes into a dozen parallel registries and nothing removes them, so every job leaks a namespace entry and a live object for the process lifetime. The namespace name also differs every run, which puts it outside `extract`, `check --peer` and `record`/`replay` entirely.

**A client-hosted sink is contract-visible and costs a peer.** The client runs an `RpcServer` with `connect`, exposes `jobSink` under a fixed name, and the job server calls it back using the caller identity from `injectInvocation`. Everything stays checkable and nothing leaks server-side. The price is a name, a token and — on MQTT — a broker session per client, plus roughly forty lines of dedupe, identity-verification and reconcile bookkeeping written by hand in every application that wants it.

The third is the best of the three and is what the library should absorb.

## Proposal 1: withdrawing a namespace

### The prerequisite is a data layout change

`ManageRpc` keys exposure across `exposedNameSpaceInstances`, `exposedNameSpaceMethodMaps`, `exposedSemantics`, `exposedEffect`, `exposedSets`, `exposedExecution`, `exposedConflation`, `exposedAuthority`, `exposedInjection`, `exposedMailbox` and `createdInstances`, plus `eventProxies`, the per-`(namespace, event)` sequence counters, the mailbox queues, and any component channel and context provider registered for it.

A `withdraw(name)` that deletes from thirteen places will eventually miss one, and every miss is silent: a stale mailbox bound, a listener still attached, a counter that never resets under a name later reused. Collapsing these into one `ExposedNamespace` record in one map is a refactor with no user-visible behaviour change, and it is what makes everything below a single `delete` rather than a checklist.

Do this first and separately. It is reviewable on its own and it is the only part that is hard to get right twice.

### The API

`exposeClassInstance` currently returns `void`, so returning a handle is purely additive. It also matches the existing house shape, where `provideContext` returns a handle that *is* the ownership.

```ts
const handle = server.exposeClassInstance(job, id, { lifetime: { peer: caller, graceMs: 30_000 } })
await handle.withdraw()
```

### What withdrawal has to get right

**Retirement needs a wire message.** `removePeer` detaches proxies when the *subscriber* goes. The reverse case — the namespace goes while the subscriber is still connected — has no frame at all, so a watcher cannot distinguish "retired" from "still running, nothing emitted yet". Emit a terminal event carrying the final `seq` and the namespace's generation, so it lands inside the existing cursor story rather than beside it.

**Two phases, not one.** Stop accepting new calls, drain the mailbox, then delete. A queued command killed by a withdrawal must be answered something specific — a `Retired` code carrying `OwnershipChanged`'s posture, *certainly did not run*. Collapsing it into `Timeout` throws away exactly the distinction the library exists to preserve.

**Names need tombstones.** Re-exposing a retired name is a new incarnation, and a client replaying subscriptions across a reconnect must not silently reattach to a different object wearing the old name. Keep the retired name's generation so re-exposure bumps it.

### Reuse the authority vocabulary

`$acquire` / `$release` already implements most of this, applied to control over a component rather than to the component's existence: a lease that always expires (`DEFAULT_AUTHORITY_TTL`, 60s), a generation bumped on acquire, takeover and expiry but never on the holder's own renewal, an `authorityChanged` event carrying `acquired | renewed | taken | released | expired` because a snapshot can say who holds it now but not whether the last holder let go or was timed out, an expiry timer that re-reads before firing so a release that beat it is not undone, and an idempotent release.

Instance lifetime is that machinery pointed at a different noun. A `withdraw` that invented its own vocabulary instead of reusing `generation` and a reason enum would be the worse design. Note that the authority state currently lives in an `RpcComponent`'s internals, so a general namespace lease needs it in the per-namespace record — which is the refactor above again.

### Lifetime binding

`transport.on(TransportEvent.peerGone, …)` already calls `removePeer` and `context.dropSubscriber`. Withdrawing peer-bound namespaces is one more line in a block that already does three cleanups.

Default it off, and give it a grace window. On MQTT `peerGone` is presence and LWT, and it flaps. A browser reloading comes back as a fresh peer, and a link blip should not destroy work that is running fine. Binding compute lifetime to a socket is how a wifi handover cancels a job.

## Proposal 2: deferred replies

Withdrawal makes the per-job-instance pattern safe. It does not make it *easy*, and it leaves the contract-invisibility problem untouched. The pattern worth having as a primitive is the client-hosted sink, with the library holding the correlation.

### Not callback parameters

The obvious API is a function parameter — `jobs.start(spec, result => …)` — with a hidden namespace exposed on the caller. It should be refused, for the same reason `set<V>(path: RpcTypedPath<V>, value)` is published loudly rather than typed as `any`: a function has no wire representation, and `extract` describes contracts in a runtime type language. It would also need a dynamic namespace per callback, inheriting the whole teardown problem, and its compatibility rules would run backwards from every other parameter's, since the caller serves it and the server calls it.

### A dispatch-level reply channel

One fixed protocol namespace on every peer, beside `$context` and `$acquire`, with a shape shipped in the library rather than generated per call. Opt in per method.

```ts
@rpc({ semantics: 'non-repeatable-command', reply: 'deferred', injectInvocation: true })
async start(spec: Spec, inv: RpcInvocationHandle): Promise<RpcTicket<JobResult>> {
    const reply = inv.defer<JobResult>()
    void this.run(spec).then(reply.resolve, reply.reject)
    return reply.ticket
}
```

```ts
const ticket = await jobs.start(spec)
ticket.on('progress', pct => setBar(pct))
const result = await ticket
```

That is the whole client side. The sink class, the dedupe map, the identity check and the expect/pending bookkeeping all move into the library.

### The security argument is the strongest one

In the hand-rolled version, the sink must verify `invocation.context.source` is the job server, or any peer on the bus can call `jobSink.finished(...)` and inject fabricated results into an operator's screen. That check is something you have to know to write, and its absence is invisible: everything works in testing and forges land in production.

Library-held correlation makes forgetting impossible. A ticket is answerable only by the peer that issued it, and that is a property the runtime can enforce rather than a comment in an example.

### Resumption belongs in the schema, not in a reply store

The first draft of this proposal had an `RpcReplyStore` alongside `RpcIdempotencyStore`, holding resolved results until an absent peer came back. tRPC's design is better and should be copied: it makes the cursor an ordinary declared *input* — `lastEventId`, validated like any other parameter, sent back automatically on reconnect — and the server holds no per-ticket state at all.

Carried across, `deferred` should resume from a cursor the caller supplies, which puts the retention question in the application's own job store where it belongs and keeps the resume path visible to `extract` and `check`. A server-held store with a retention policy nobody can pick correctly is the thing to avoid.

### Two deadlines, never conflated

`$with({ timeoutMs })` bounds the `start` call. A deferred deliberately outlives it. The ticket needs its own expiry, transmitted separately, or people will set one meaning the other.

### Abandonment, which is not cancellation

Once the waiting peer is gone, the handler is computing for nobody. The library cannot tell a running method to stop, but it can report a fact.

```ts
reply.on('abandoned', () => { /* the handler's choice: stop, or don't */ })
```

Name it for what it is. It is an observable truth about the network delivered to code that may or may not act on it, which is a much smaller promise than `cancel()` and, unlike `cancel()`, one the library can keep. It also relieves the pressure that will otherwise push toward a cancellation API that cannot be implemented honestly.

### Scope against the queue package

`@source-repo/queue` already does durable long work with leases and dead letters. If `deferred` results die with the process, that is defensible — but it has to be the first line of the documentation, not a footnote, or people will reach for the lighter thing and discover the difference during a restart.

## Two smaller fixes, independent of the above

**`exposeClassInstance` should refuse to overwrite.** It assigns into `exposedNameSpaceInstances[namespace]` with no collision check, and `createRpcInstance` lets the caller choose the name. An authorized peer can therefore create an instance named `plant` and silently displace the exposed plant. `params` is in `RpcCallContext`, so an authorizer *can* inspect the requested class and name, but that is an application rebuilding a type system in a callback. Throw unless passed `{ replace: true }`.

**`RpcServer` should surface link events.** `RpcClient` re-emits transport state; `RpcServer` forwards `connected`, `disconnected`, `peerGone` and `peerDisplaced` to its component lifecycle and does not expose them. An application that dials out with `connect` — which is now the recommended shape for a browser peer that also serves — has to reach into `server.transports[0]` to know it reconnected, which is exactly the moment it must reconcile. Re-emit them on the server.

## Non-goals

**No cancellation.** It needs handler cooperation the library cannot supply. The type should not have the method, and the reason should be stated at the API rather than only in the "what it does not do" section.

**No TTL sweeper and no refcounting for instances.** An instance retired by a timer while the author still holds a reference is worse than a leak, because the object now exists and is unreachable. Give `withdraw` and optional peer binding; a TTL is application policy. This is deliberately narrower than the authority lease, which expires because *control* held by an absent peer blocks everyone, whereas an *object* held by an absent peer blocks nobody.

## Open questions

1. Does `deferred` need `RemoteSurface` to grow a second mapped-type rule beside `WithoutInvocation`, so a handler returning `RpcTicket<T>` presents to the caller as an awaitable and subscribable handle? Prototype this in the types before writing any runtime — if it cannot be expressed cleanly there, the API is not right yet.
2. Should a withdrawn namespace's name be permanently reserved, or reusable at a bumped generation? Reuse is friendlier for a pooled-slot design; reservation is safer for stale cursors.
3. Does `Retired` warrant a new error code, or should it reuse `OwnershipChanged` with a different reason? The posture is identical; only the cause differs.
4. Should peer-bound lifetime be expressible declaratively on the class, or only at `exposeClassInstance` time? The former reads better and hides the fact that lifetime is a property of the exposure, not of the object.
