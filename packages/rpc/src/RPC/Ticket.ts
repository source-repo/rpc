import { EventEmitter } from 'events'

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
 * What a caller receives: a handle to work happening elsewhere, with the answer on `result`.
 *
 * **It is deliberately not thenable, and that is not a style choice.** A deferred method is reached
 * through an ordinary call, so the caller writes `await jobs.start(spec)` - and `await` unwraps
 * thenables *recursively*. Had a ticket been a `PromiseLike<T>`, that first await would have
 * flattened straight through it to `T`, in the types and at runtime, and the handle would never
 * have existed to subscribe to. The progress channel would have been unreachable by construction.
 *
 * So the result is a property rather than the ticket itself:
 *
 * ```typescript
 * const ticket = await jobs.start(spec)
 * ticket.on('progress', (pct) => setBar(pct))
 * const result = await ticket.result
 * ```
 *
 * Which reads only slightly longer and cannot be got wrong.
 */
export interface RpcTicket<T, P = unknown> {
    /** What the work produced, when it produces it. Rejects if it fails, lapses or is orphaned. */
    readonly result: Promise<T>
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

/**
 * Kept as a name for what `RpcInvocationHandle` already is.
 *
 * `defer` lives on the handle itself rather than on an extension of it, and that is not a
 * convenience - `WithoutInvocation` strips a trailing handle only when the parameter's type is
 * *exactly* `RpcInvocationHandle`, bidirectionally, so that a trailing `unknown` is not mistaken
 * for one. An intersection would fail that check, and a handler asking to defer would find its
 * injected parameter had stopped being stripped from the caller's signature.
 */
export type RpcInvocationWithDefer = import('./Invocation.js').RpcInvocationHandle

/**
 * How long a ticket stands unless the method says otherwise.
 *
 * Not the call's deadline and deliberately far longer than one. `$with({ timeoutMs })` bounds the
 * call that *started* the work; a deferred reply exists precisely to outlive it. Anyone given one
 * number will set it meaning the other, so they are transmitted separately and defaulted apart.
 */
export const DEFAULT_TICKET_TTL = 30 * 60_000

/**
 * The server's half: a ticket to hand back, and the means to answer it later.
 *
 * The ticket's id **is the request's id**, which is the whole trick. The caller is already waiting
 * on that id and registered it before the frame left, so there is no window in which a result can
 * arrive naming a ticket the caller has not yet heard of - a race that would otherwise need a
 * holding buffer and a reconciliation pass. It costs no bytes, since the id is already in the
 * frame, and it makes correlation something the runtime knows rather than something a payload
 * asserts.
 */
export const createDeferred = <T, P = unknown>(
    id: string,
    expiresAt: number,
    send: (outcome: 'progress' | 'resolved' | 'rejected', value?: unknown, error?: unknown) => void
): RpcDeferred<T, P> & { abandon(): void } => {
    const events = new EventEmitter()
    let settled = false
    // A ticket is answered once. A handler that resolves twice - or resolves after rejecting - has
    // a bug, and forwarding both would move it onto the caller where it is much harder to see.
    const once = (act: () => void) => {
        if (settled) return
        settled = true
        act()
    }
    const deferred = {
        get ticket() {
            return ticket
        },
        resolve: (value: T) => once(() => send('resolved', value)),
        reject: (error: unknown) => once(() => send('rejected', undefined, error)),
        progress: (update: P) => {
            if (!settled) send('progress', update)
        },
        on(event: 'abandoned', listener: () => void) {
            events.on(event, listener)
            return deferred
        },
        /** The caller has gone. A fact reported to the handler, never an instruction. */
        abandon: () => events.emit('abandoned')
    }
    // The server never awaits its own ticket; `then` is here so the object satisfies the type the
    // handler returns, and so a handler that awaits one by mistake hangs rather than resolving to
    // something meaningless.
    // The server never awaits its own ticket; `result` is here so the object satisfies the type the
    // handler returns. A handler that awaits one by mistake waits forever rather than resolving to
    // something meaningless.
    const ticket = { id, expiresAt, result: new Promise<T>(() => undefined), on: () => ticket, off: () => ticket } as unknown as RpcTicket<T, P>
    return deferred
}

/** A remote failure, made into something a catch block can treat as one. */
const asError = (error: unknown) => {
    if (error instanceof Error) return error
    const remote = error as { name?: unknown; message?: unknown; stack?: unknown } | undefined
    const rebuilt = new Error(typeof remote?.message === 'string' ? remote.message : 'the deferred work failed')
    if (typeof remote?.name === 'string') rebuilt.name = remote.name
    if (typeof remote?.stack === 'string') rebuilt.stack = remote.stack
    return rebuilt
}

/** A ticket the caller holds, and what the registry needs to answer it. */
interface Held {
    settle: { resolve: (value: unknown) => void; reject: (error: unknown) => void }
    events: EventEmitter
    /** The peer this call was sent to. Nobody else may answer it. */
    target: string
    lapses?: ReturnType<typeof setTimeout>
    /**
     * Progress that arrived before anything was listening for it.
     *
     * A caller cannot subscribe until it holds the ticket, and it cannot hold the ticket until the
     * call has answered - so on a fast link, and always for a reply that arrived early enough to be
     * held, the first progress is here before there is anywhere to put it. Emitting it to an
     * EventEmitter with no listeners is not delivery, it is a silent drop, and the caller sees a job
     * that reports nothing until it finishes.
     */
    heldProgress?: unknown[]
    /** Set by the first `on('progress')`, after which progress is emitted rather than held. */
    watched?: boolean
}

/** How much progress is held for a subscriber that has not arrived. Bounded, because one may never. */
const MAX_HELD_PROGRESS = 64

/**
 * The caller's half: tickets outstanding, and the rule about who may answer one.
 *
 * **A reply is accepted only for a request this peer actually made, to the peer it made it to.**
 * Both facts are already held here - the id because the caller registered it before the frame left,
 * and the target because it chose it - so the check costs a map lookup and a string comparison and
 * cannot be forgotten. That is the whole security argument for putting this in the library: written
 * by hand, the check is something an author must know to write, and its absence is invisible until
 * somebody on the bus injects a fabricated result onto an operator's screen.
 */
export class RpcTickets {
    private readonly held = new Map<string, Held>()
    /**
     * A reply that overtook the answer naming its ticket.
     *
     * On an ordered transport this never happens - the answer was sent first. MQTT publishes on
     * different topics and gives no such guarantee, so a result can land before the caller has
     * opened the ticket it belongs to. Held only for ids the caller confirms it has a call out for,
     * and drained when the ticket opens, so this cannot become somewhere a stranger leaves things.
     */
    private readonly early = new Map<string, { from: string; outcome: 'progress' | 'resolved' | 'rejected'; value: unknown; error: unknown }[]>()

    /** Register before the call goes out, which is what makes the id a promise nobody else can claim. */
    open<T, P = unknown>(id: string, target: string, expiresAt: number): RpcTicket<T, P> {
        const events = new EventEmitter()
        let settle!: Held['settle']
        const answer = new Promise<T>((resolve, reject) => {
            settle = { resolve: resolve as (value: unknown) => void, reject }
        })
        // A rejection nobody is awaiting yet is an unhandled rejection, and a ticket is explicitly
        // for work whose result is collected later. Parked so the process survives being told early.
        answer.catch(() => undefined)
        const entry: Held = { settle, events, target }
        if (expiresAt > Date.now()) {
            entry.lapses = setTimeout(() => {
                this.held.delete(id)
                settle.reject(new Error(`the ticket for ${id} lapsed at ${new Date(expiresAt).toISOString()} with no answer`))
            }, expiresAt - Date.now())
            entry.lapses.unref?.()
        }
        this.held.set(id, entry)
        for (const waiting of this.early.get(id) ?? []) this.deliver(id, waiting.from, waiting.outcome, waiting.value, waiting.error)
        this.early.delete(id)
        const ticket: RpcTicket<T, P> = {
            id,
            expiresAt,
            result: answer,
            on: (event: 'progress' | 'abandoned', listener: (...args: never[]) => void) => {
                events.on(event, listener as (...args: unknown[]) => void)
                if (event === 'progress' && !entry.watched) {
                    entry.watched = true
                    const held = entry.heldProgress ?? []
                    entry.heldProgress = undefined
                    // To the listener that just arrived, and only it: nothing else was there. On a
                    // later turn, so a subscriber cannot be called back inside its own `on`.
                    for (const value of held) queueMicrotask(() => (listener as (...args: unknown[]) => void)(value))
                }
                return ticket
            },
            off: (event: 'progress' | 'abandoned', listener: (...args: never[]) => void) => {
                events.off(event, listener as (...args: unknown[]) => void)
                return ticket
            }
        }
        return ticket
    }

    /**
     * Answer a ticket, if the peer answering is the one that was asked.
     *
     * Returns whether it was accepted, so a caller can report a refusal rather than let a forgery
     * fail silently - a rejected attempt is worth seeing, and an ignored one is not evidence of
     * anything.
     */
    deliver(id: string, from: string, outcome: 'progress' | 'resolved' | 'rejected', value: unknown, error: unknown): boolean {
        const entry = this.held.get(id)
        if (!entry || entry.target !== from) return false
        if (outcome === 'progress') {
            if (!entry.watched) {
                // Oldest first when the bound is reached: a caller arriving late wants where the
                // work has got to rather than where it began, and a job that reports for an hour
                // must not grow this without limit while nobody is listening.
                const held = (entry.heldProgress ??= [])
                if (held.length >= MAX_HELD_PROGRESS) held.shift()
                held.push(value)
                return true
            }
            entry.events.emit('progress', value)
            return true
        }
        this.forget(id)
        if (outcome === 'resolved') entry.settle.resolve(value)
        // Rebuilt as an Error rather than passed on as the shape it travelled in. A remote failure
        // arrives as `{ name, message, stack }`, and rejecting with that hands the caller something
        // that is not an error - no stack to print, nothing an `instanceof` check recognises, and a
        // catch block written the ordinary way quietly does the wrong thing with it.
        else entry.settle.reject(asError(error))
        return true
    }

    /**
     * Hold a reply that arrived before its ticket. The caller vouches that the id is a call it has
     * out, which is the same fact the target check rests on - so this is not a door of its own.
     */
    holdEarly(id: string, from: string, outcome: 'progress' | 'resolved' | 'rejected', value: unknown, error: unknown) {
        const waiting = this.early.get(id) ?? []
        waiting.push({ from, outcome, value, error })
        this.early.set(id, waiting)
    }

    /** The peer holding this work has gone, so nothing will answer. */
    dropTarget(peer: string) {
        for (const [id, entry] of this.held) {
            if (entry.target !== peer) continue
            this.forget(id)
            entry.settle.reject(new Error(`${peer} went away before answering the ticket for ${id}`))
        }
        for (const [id, waiting] of this.early) if (waiting.every((one) => one.from === peer)) this.early.delete(id)
    }

    private forget(id: string) {
        const entry = this.held.get(id)
        if (entry?.lapses) clearTimeout(entry.lapses)
        this.held.delete(id)
    }

    get outstanding() {
        return this.held.size
    }
}
