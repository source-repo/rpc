import test from 'ava'
import type { RemoteSurface, RpcInvocationHandle } from './index.js'
import type { RpcDeferred, RpcTicket } from './RPC/Ticket.js'

/**
 * The gate the design note puts before any runtime: can a deferred reply be *said* in the type
 * system this library already has?
 *
 * Everything here is a compile-time assertion. The bodies do nothing and the assertions are the
 * declarations themselves - if a shape below stops holding, `npm run build` fails and this file
 * never runs at all. That is the point: a runtime test of a type is worth nothing.
 *
 * See `notes/extending-rpc-design/deferred-results-proposal.md`, open question 1.
 */

type Spec = { what: string }
type JobResult = { rows: number }

/** A service as it would be written: an injected handle in, a ticket out. */
declare class Jobs {
    start(spec: Spec, inv: RpcInvocationHandle): Promise<RpcTicket<JobResult, number>>
    ordinary(spec: Spec): Promise<number>
}

/** `A extends B` and `B extends A`, so a drifted type is a compile error rather than a wider one. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const exact = <T extends true>(_proof: T) => undefined

test('a handler returning a ticket needs no second rule in RemoteSurface', (t) => {
    // Open question 1, answered: **no**. `WithoutInvocation` strips the injected handle from the
    // parameters and passes the return type through untouched, and the return type is already what
    // the caller should hold - so the caller's surface is correct with the machinery that exists.
    //
    // That is worth having proved rather than assumed. The alternative - a second mapped rule that
    // rewrites a returned `RpcTicket<T>` into some other caller-side type - would have meant two
    // spellings of one thing and a compatibility story running in two directions at once.
    exact<Exact<RemoteSurface<Jobs>['start'], (spec: Spec) => Promise<RpcTicket<JobResult, number>>>>(true)
    exact<Exact<RemoteSurface<Jobs>['ordinary'], (spec: Spec) => Promise<number>>>(true)
    t.pass()
})

type Ticket = RpcTicket<JobResult, number>

/**
 * Never called, and that is the point: the body is checked by the compiler and running it would
 * only prove that a `declare` produces nothing at runtime. Every assertion in this file is made by
 * the declaration rather than by the execution.
 */
const subscribes = (ticket: Ticket) => {
    ticket.on('progress', (update: number) => void update)
    ticket.on('abandoned', () => undefined)
    ticket.off('progress', () => undefined)
}

test('a ticket is a handle with the answer on it, and is deliberately not thenable', (t) => {
    // The assertion this file exists for, and the one it did not make the first time.
    //
    // A deferred method is reached through an ordinary call, so a caller writes
    // `await jobs.start(spec)` - and `await` unwraps thenables *recursively*. Were a ticket
    // `PromiseLike<T>`, that first await would flatten straight through it to `T` and the handle
    // would never exist to subscribe to: the progress channel unreachable by construction, in the
    // types and at runtime both.
    exact<Exact<Awaited<Promise<Ticket>>, Ticket>>(true)
    exact<Exact<Ticket extends PromiseLike<unknown> ? true : false, false>>(true)

    // The answer is a property, which reads only slightly longer and cannot be got wrong.
    exact<Exact<Awaited<Ticket['result']>, JobResult>>(true)

    // Subscribable, with the progress payload typed rather than unknown.
    void subscribes
    t.pass()
})

test('the two sides of a ticket are different objects with the same payload type', (t) => {
    // A handler resolves; a caller awaits. The type parameter is shared, so a handler that resolves
    // the wrong shape is a compile error at the point that produced it rather than at the screen
    // that eventually drew it.
    type Deferred = RpcDeferred<JobResult, number>
    exact<Exact<Parameters<Deferred['resolve']>[0], JobResult>>(true)
    exact<Exact<Parameters<Deferred['progress']>[0], number>>(true)
    exact<Exact<Awaited<Deferred['ticket']['result']>, JobResult>>(true)
    t.pass()
})
