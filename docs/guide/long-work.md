# Work that takes longer than a call

**These results die with the process.** A deferred reply lives in memory on both peers. If the server restarts, the work is gone and the ticket rejects; nothing is retried and nothing is stored. For work that must survive a restart — anything a plant would be sorry to lose — use [`@source-repo/queue`](../packages/queue.md), which has leases, retries, dead letters and a durable store. That sentence is first because the two look alike from the outside and the difference only shows up during a restart.

With that said: a report, a scan, a batch import. The caller wants the result, the result belongs to that caller and to nobody else, and it will not arrive inside any sane call deadline.

## The shape

```typescript
import { rpc, rpcNamespace, RpcComponent, type RpcInvocationHandle, type RpcTicket } from '@source-repo/rpc'

@rpcNamespace('jobs')
class Jobs {
    @rpc({ semantics: 'non-repeatable-command', injectInvocation: true })
    async start(spec: Spec, inv: RpcInvocationHandle): Promise<RpcTicket<JobResult, number>> {
        const reply = inv.defer<JobResult, number>()
        void this.run(spec, reply.progress).then(reply.resolve, reply.reject)
        return reply.ticket
    }
}
```

```typescript
const ticket = await jobs.start(spec)

ticket.on('progress', (percent) => setBar(percent))
const result = await ticket.result
```

The call answers immediately, with a correlation id and an expiry. The work answers later, to the peer that asked.

## A ticket is not a promise

`await ticket.result`, not `await ticket`. That reads like a small stylistic choice and it is not one.

A deferred method is reached through an ordinary call, so a caller writes `await jobs.start(spec)`. And `await` unwraps thenables **recursively**. Were a ticket a `PromiseLike<T>`, that first `await` would flatten straight through the handle to the result — in the types and at runtime both — and the handle would never exist to subscribe to. The progress channel would be unreachable by construction.

So the answer sits on the ticket rather than being the ticket.

## Only the peer that was asked can answer

A ticket's id **is the id of the call that created it**. The caller was already waiting on that id and registered it before the frame left, so a reply is accepted only for a call this peer actually made, to the peer it actually made it to.

That is the reason for this being in the library rather than in each application. Hand-rolled — a result sink the job server calls back — the sink has to verify that whoever is reporting the result is the peer the work was given to. It is a check you have to know to write, its absence is invisible, and it fails by letting anyone on the bus put a fabricated number on an operator's screen. Here it is a property of how the reply travels, so it cannot be forgotten.

A refused attempt is reported rather than dropped:

```typescript
client.rpcClient.on('ticketRefused', ({ id, from }) => log.warn(`${from} tried to answer a ticket it was not given`))
```

Silence would not be evidence of anything.

## Two deadlines, never the same one

`$with({ timeoutMs })` bounds the **call** that starts the work. The ticket carries its own expiry, sent separately and defaulted an order of magnitude longer, because a deferred reply exists precisely to outlive the call.

Anyone given one number will eventually set it meaning the other, so there are two.

## Abandonment is not cancellation

When the waiting peer goes, the handler is told:

```typescript
reply.on('abandoned', () => this.stopIfYouLike())
```

The library cannot make a running method stop, so it does not offer `cancel()` — a promise it could not keep. What it can do is report a fact truthfully and let the handler decide. On the caller's side the same event rejects outstanding tickets rather than leaving them to lapse at an expiry half an hour away.

## Resuming after a break

There is deliberately **no server-side reply store**. Nothing holds a resolved result waiting for an absent peer to come back, and nothing has a retention policy for you to get wrong.

A brief link blip needs nothing: tickets survive a reconnect, because it is the *peer going* that ends them, not the socket. Beyond that — a server restart, a page reloaded an hour later — resumption is an ordinary parameter:

```typescript
@rpc({ semantics: 'query' })
async since(jobId: string, lastEventId?: string): Promise<Update[]> { … }
```

The cursor is a declared input, checked like any other, visible to `extract` and `check`, and the retention question lives in the application's own job store where it belongs. A caller that comes back asks again from where it got to. This is [tRPC's design](https://trpc.io) and it is better than what the first draft of this feature had.

## What the contract says

A deferred method is described in two parts, because two things travel:

```json
"start": {
    "returns": { "kind": "object", "fields": { "id": …, "expiresAt": … } },
    "deferred": { "result": { "kind": "ref", "name": "JobResult" }, "progress": { "kind": "number" } }
}
```

`returns` is what the **call** answers. `deferred` is what the ticket will. Compatibility checks the deferred payload exactly as it checks a return, so a result type that changes incompatibly is still a breaking change — and moving a result *into* or *out of* a ticket is breaking too, since every type can still line up while a caller waiting on the reply receives a correlation id instead.

## Taking an instance away again

A host that stands something up per job needs to be able to take it down:

```typescript
const handle = server.exposeClassInstance(new Job(spec), `job.${id}`)
// …later
await handle.withdraw()
```

Withdrawing stops new calls at once — a call arriving afterwards is refused like any unknown path — detaches the subscriptions taken out on it, and tells whoever was watching with a `$retired` event carrying the generation that just ended. That event exists because retirement otherwise has no frame at all: a watcher could not tell a retired instance from a live one that had simply not emitted lately.

Re-exposing the name later is a **new incarnation** at a bumped generation. A name is not a thing; it is a place a thing stands, and a client replaying its subscriptions across a reconnect must not silently reattach to a different object wearing the old name.

**A call already queued is answered, not run.** Withdrawing stops new calls at the door, but a call already waiting behind a serialised instance holds a bound handler and would otherwise run into something nobody can reach. It is refused `OwnershipChanged` instead — which already means *certainly did not run*, the one thing a caller needs in order to decide what to do next. Letting it die of its deadline would have called that an unknown outcome, which is exactly the distinction this library exists to preserve.

**Binding a lifetime to a peer, if you want it:**

```typescript
server.exposeClassInstance(new Job(spec), `job.${id}`, {
    lifetime: { peer: caller, graceMs: 30_000 }
})
```

Off unless asked for, and never without a grace window. On MQTT `peerGone` is presence and a last will, and it flaps; a browser reloading comes back as a fresh peer moments later. Retiring on the event itself is how a wifi handover cancels somebody's job, so the departure has to persist through the window before anything is taken away.

Nothing expires an instance on a timer otherwise. An object retired out from under an author who still holds a reference is worse than a leak, because it exists and is unreachable — so lifetime is `withdraw()`, an optional peer binding, and the host's own judgement.
