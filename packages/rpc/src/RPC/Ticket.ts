import type { RpcInvocationHandle } from './Invocation.js'

/**
 * Types only, and deliberately so: the shapes a deferred reply would need, with no runtime behind
 * them yet.
 *
 * The design note makes proving these the gate before any implementation, and it is the right gate.
 * A deferred reply is the one feature here whose *type* is the hard part - a handler returns a
 * thing the caller receives as a different thing, the contract has to describe what actually
 * travels rather than what TypeScript sees, and if that cannot be said cleanly then the API is
 * wrong and no amount of runtime will rescue it. See
 * `notes/extending-rpc-design/deferred-results-proposal.md`.
 *
 * **What a ticket is on the wire is not what it is in a program.** What travels is a correlation id
 * and an expiry. What a caller holds is something awaitable that also reports progress, and what a
 * handler holds is something it resolves. Three views of one thing, and the schema has to describe
 * the first while the other two stay comfortable to write.
 */

/**
 * What a caller receives: awaitable for the result, subscribable for what happens on the way.
 *
 * `PromiseLike` rather than `Promise` on purpose. A ticket is not a promise that happens to have
 * extra methods - it is a handle to work being done elsewhere, and inheriting `catch`, `finally`
 * and the rest would invite `Promise.all` over a set of them as though they were cheap and local.
 * `await` is the one promise-shaped thing it should support, and `PromiseLike` is exactly that.
 */
export interface RpcTicket<T, P = unknown> extends PromiseLike<T> {
    /** Correlation, and the only part of this that travels. */
    readonly id: string
    /**
     * When the *ticket* lapses, which is not when the call that issued it lapses.
     *
     * Two deadlines that must never be conflated: `$with({ timeoutMs })` bounds the call that
     * started the work, and a deferred reply deliberately outlives it. Carried separately because
     * anyone given one number will set it meaning the other.
     */
    readonly expiresAt: number
    on(event: 'progress', listener: (update: P) => void): this
    /**
     * The work was abandoned - the peer waiting for it has gone.
     *
     * A fact rather than an instruction, and named for what it is. The library cannot stop a running
     * handler, so it must not offer `cancel()`; it can say truthfully that nobody is listening any
     * more, and let the handler decide. That is a much smaller promise and one that can be kept.
     */
    on(event: 'abandoned', listener: () => void): this
    off(event: 'progress' | 'abandoned', listener: (...args: never[]) => void): this
}

/** What a handler holds: the ticket to return, and the means to answer it later. */
export interface RpcDeferred<T, P = unknown> {
    readonly ticket: RpcTicket<T, P>
    resolve(value: T): void
    reject(error: unknown): void
    progress(update: P): void
    on(event: 'abandoned', listener: () => void): this
}

/** What `injectInvocation` would grow, so a handler can defer from inside an ordinary call. */
export interface RpcDeferring {
    defer<T, P = unknown>(): RpcDeferred<T, P>
}

/** The handle as it would look once deferral exists. Not yet implemented; this is the shape. */
export type RpcInvocationWithDefer = RpcInvocationHandle & RpcDeferring
