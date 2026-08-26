import { v4 as uuidv4 } from 'uuid'
import type { RpcDerivedStore } from './ComponentClient.js'
import type { RpcErrorCode, RpcMethodSemantics } from './Messages.js'

/**
 * What this peer has asked other peers to do, and how each of those turned out.
 *
 * A client already knows all of this - it mints the id, holds the promise, arms the timer and
 * classifies the failure - and then throws it away the moment the promise settles. Which is fine
 * for a program, because a program has the promise. It is not fine for a **person**, because the
 * one thing an operator needs after pressing a button on a plant is not the return value: it is
 * whether the command ran, and if nobody knows, that nobody knows.
 *
 * So this keeps one frozen entry per call, replaced whole on every change, in the same
 * `getSnapshot`/`subscribe` shape the component store already defines - a screen binds to it with
 * `useSyncExternalStore` and nothing new has to be learned.
 *
 * **Hooked in exactly one place.** `callWith` is already the single funnel every call goes through:
 * a client's, a server-acting-as-caller's, and a component channel's. So a server gets this registry
 * with no second implementation, and there is no wire change and no contract change anywhere - this
 * is a peer writing down what it already did.
 *
 * **Arguments and results are not retained, and that is a security property rather than a
 * preference.** An `untap(token)` argument is a bearer capability and a `$data` answer is a page of
 * plant rows; a peer-wide store holding either would hand every screen in the process a read surface
 * that `authorize()` was protecting on the way in. What is kept is a *description of the request* -
 * who, what, when, how it ended - which is what a tray is for, and which nothing was ever asked to
 * keep secret.
 *
 * The error's `message` is the one judgement call, and it is kept: a message is a sentence about the
 * failure written by the far end, and a peer that puts a secret in one has already sent it here.
 */

/**
 * Where a call has got to.
 *
 * Six, and the sixth is the reason this exists. **`unknown-outcome` is a status rather than an error
 * string**, because it is the one a tray must not let scroll away: the command was sent, nothing
 * came back, and it may or may not have run. Both `UnknownOutcome` and `Timeout` land here - the
 * code is kept beside it, because `Timeout` says *why* nothing is known and that is more use than
 * the general case, but the two are the same fact about the plant and a screen sorting on the status
 * must find them together.
 *
 * `issued` and `sent` are also two rather than one, and it is the library's founding distinction:
 * a request the transport never accepted certainly did not run, and one it did may have.
 *
 * `deferred` is a method that answers twice - the ticket arrived, the work is still going. The call
 * succeeded and the *operation* did not, which one status could not say.
 */
export type RpcOperationStatus = 'issued' | 'sent' | 'deferred' | 'succeeded' | 'failed' | 'unknown-outcome'

/** One call, as a fact about what this peer asked for. Frozen, and replaced rather than mutated. */
export interface RpcOperation {
    /** The request id, which is also what the far end's idempotency store sees as the attempt. */
    readonly id: string
    /** The peer it was addressed to. Absent for a call sent without a target, on a link with one peer. */
    readonly target?: string
    readonly namespace: string
    readonly method: string
    /**
     * What the caller says this method does, where it said anything.
     *
     * **The caller's claim, and it decides nothing here.** A client holds no schema, and this
     * repository's own rule is that the running class beats the schema for this question anyway - so
     * a client-side semantics is for a screen to read, never for a mechanism to gate on. What it is
     * worth is exactly the difference between a tray that can say "this uncertain one was a
     * non-repeatable command" and one that shows an operator six identical rows.
     */
    readonly semantics?: RpcMethodSemantics
    /** The key that makes a second attempt the same command, where the caller named one. */
    readonly idempotencyKey?: string
    /** What the caller declared it would wait, in milliseconds. Absent means no deadline. */
    readonly deadlineMs?: number
    readonly issuedAt: number
    /** When the transport accepted it - the line between certainly-did-not-run and may-have. */
    readonly sentAt?: number
    readonly settledAt?: number
    readonly status: RpcOperationStatus
    /** The code the failure carried, kept beside the status because `Timeout` says why. */
    readonly code?: RpcErrorCode
    /** The far end's sentence about the failure. Never an argument and never a result. */
    readonly message?: string
    /**
     * The peer this went *through*, where it did not go direct.
     *
     * Present only on an entry recorded by `relayed`. It matters on a screen because a relayed
     * operation has two places to fail and they are different facts: the relay not answering says
     * nothing about the plant, and the relay answering *with* an uncertain outcome says the command
     * reached the plant and nobody knows what it did.
     */
    readonly via?: string
}

/** An operation performed through another peer. See `RpcOperations.relayed`. */
export interface RpcRelayedOperation {
    /** The peer that made the call on this one's behalf. */
    readonly via: string
    /** The peer it was ultimately for. */
    readonly target?: string
    readonly namespace: string
    readonly method: string
    readonly semantics?: RpcMethodSemantics
    readonly idempotencyKey?: string
}

export interface RpcOperationsOptions {
    /**
     * How many entries to keep.
     *
     * Bounded because a peer that runs for months makes a great many calls, and an unbounded tray is
     * a leak with a user interface. What it evicts is the interesting part - see `record`.
     */
    keep?: number
}

/** Whether an outcome is one somebody has to go and look at, rather than one the program handled. */
export const uncertain = (status: RpcOperationStatus): boolean => status === 'unknown-outcome'

/**
 * Whether a failure means the command **may have run**.
 *
 * `UnknownOutcome` says so directly. `Timeout` says the request went out and nothing came back,
 * which is the same fact about the plant reached by a different route - and treating it as an
 * ordinary failure is the library telling a caller a command did not happen when what it knows is
 * that it lost track of it.
 *
 * Exported because the registry must not be the only thing that knows this. A screen deciding
 * whether to offer *try again* has to classify a failure exactly the way the tray beside it does, or
 * the two disagree in front of an operator about the only question that mattered.
 */
export const mayHaveRun = (failure: unknown): boolean => {
    const code = (failure as { code?: RpcErrorCode } | undefined)?.code
    return code === 'UnknownOutcome' || code === 'Timeout'
}

export class RpcOperations {
    private entries: readonly RpcOperation[] = Object.freeze([])
    private readonly byId = new Map<string, RpcOperation>()
    private readonly listeners = new Set<() => void>()
    private readonly keep: number

    constructor(options: RpcOperationsOptions = {}) {
        this.keep = Math.max(1, options.keep ?? 200)
    }

    /** Newest last, which is the order a tray reads in and the order they happened. */
    getSnapshot(): readonly RpcOperation[] {
        return this.entries
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    /**
     * Narrow what a consumer re-renders for - the count of uncertain ones, the entries for one peer.
     *
     * The same shape and the same hazard as the component store's: a selector returning a fresh
     * object from every `getSnapshot` is React's cached-snapshot loop, so this caches and `isEqual`
     * is the sharp edge. One that calls a changed value unchanged freezes a pane, and a frozen tray
     * is indistinguishable from a plant that has stopped being commanded.
     */
    select<T>(selector: (operations: readonly RpcOperation[]) => T, isEqual: (a: T, b: T) => boolean = Object.is): RpcDerivedStore<T> {
        let held: { value: T } | undefined
        const read = () => {
            const next = selector(this.entries)
            if (held && isEqual(held.value, next)) return held.value
            held = { value: next }
            return next
        }
        return {
            getSnapshot: read,
            subscribe: (listener: () => void) =>
                this.subscribe(() => {
                    const before = held?.value
                    const after = read()
                    if (held && before !== undefined && isEqual(before, after)) return
                    listener()
                })
        }
    }

    /** One entry, for a caller that kept an id. */
    at(id: string): RpcOperation | undefined {
        return this.byId.get(id)
    }

    /**
     * Forget the ones that are over and certain.
     *
     * Deliberately not "forget everything": an uncertain outcome is the one thing here nobody may
     * clear by pressing a button that says something else. A tray offering *dismiss* has to make an
     * operator dismiss that one on purpose, which is what `forget` is for.
     */
    clearSettled(): void {
        const kept = this.entries.filter((entry) => entry.status !== 'succeeded' && entry.status !== 'failed')
        if (kept.length === this.entries.length) return
        this.byId.clear()
        for (const entry of kept) this.byId.set(entry.id, entry)
        this.publish(kept)
    }

    /** Forget one, whatever it is. The deliberate act an uncertain outcome needs. */
    forget(id: string): void {
        if (!this.byId.delete(id)) return
        this.publish(this.entries.filter((entry) => entry.id !== id))
    }

    /**
     * A call has been made. Called from `callWith` and nowhere else.
     *
     * The eviction rule lives here, and it is the whole reason `keep` is not a slice. Three tiers,
     * and each of them is a claim about who still has business with the row.
     *
     * **Over and certain goes first** - `succeeded` or `failed`, oldest first. Nobody has anything
     * further to do with those.
     *
     * **Then the oldest `unknown-outcome`.** Bounded is bounded and a tray that grew without limit
     * would be a leak with a user interface, but this is the row a person is meant to act on, so it
     * outlives every settled call above it rather than scrolling off in front of them.
     *
     * **A call still in flight is never dropped**, which means the registry can exceed `keep` -
     * deliberately. Evicting one would take a command *off* an operator's screen while it was still
     * happening, and would then have nowhere to record the `unknown-outcome` it may be about to
     * become. It costs nothing to keep: the client is already holding a promise for each of them, so
     * this is bounded by the program's own concurrency rather than by its uptime.
     */
    record(operation: RpcOperation): void {
        const entry = Object.freeze(operation)
        this.byId.set(entry.id, entry)
        let next = [...this.entries, entry]
        while (next.length > this.keep) {
            let drop = next.findIndex((one) => one.status === 'succeeded' || one.status === 'failed')
            if (drop < 0) drop = next.findIndex((one) => one.status === 'unknown-outcome')
            if (drop < 0) break
            this.byId.delete(next[drop].id)
            next = [...next.slice(0, drop), ...next.slice(drop + 1)]
        }
        this.publish(next)
    }

    /**
     * Write down an operation this peer performed **through** another peer.
     *
     * The one thing here not hooked at `callWith`, and it is not a second implementation - it is the
     * case `callWith` structurally cannot see. A console page does not call the plant: it asks the
     * console to, and the console reports the plant's answer *as a value* rather than by failing. So
     * the page's own entry for that call says `succeeded` - correctly, the relay worked - while the
     * command it was about may have been left in the air. A tray built only on what `callWith` saw
     * would show the one outcome an operator must never be shown wrongly.
     *
     * The relayed outcome has to reach this as a **rejection**, because that is the only shape
     * `mayHaveRun` can classify - a caller turning a reported failure back into an error is doing
     * the same translation the transport does for a direct call.
     *
     * There is no `sent` here, deliberately. That status means *this* peer's transport accepted the
     * frame, which is the line between certainly-did-not-run and may-have; for a relay this peer
     * never sent it and cannot vouch for that line. What carries it instead is the relayed code.
     */
    async relayed<T>(what: RpcRelayedOperation, act: () => Promise<T>): Promise<T> {
        const id = uuidv4()
        this.record({
            id,
            ...(what.target !== undefined ? { target: what.target } : {}),
            namespace: what.namespace,
            method: what.method,
            ...(what.semantics !== undefined ? { semantics: what.semantics } : {}),
            ...(what.idempotencyKey ? { idempotencyKey: what.idempotencyKey } : {}),
            issuedAt: Date.now(),
            status: 'issued',
            via: what.via
        })
        try {
            const answer = await act()
            this.advance(id, { status: 'succeeded', settledAt: Date.now() })
            return answer
        } catch (failure) {
            this.rejected(id, Date.now(), failure)
            throw failure
        }
    }

    /** Move one on, keeping everything already known about it. Silent for an id already evicted. */
    advance(id: string, change: Partial<RpcOperation>): void {
        const held = this.byId.get(id)
        if (!held) return
        const entry = Object.freeze({ ...held, ...change })
        this.byId.set(id, entry)
        this.publish(this.entries.map((one) => (one.id === id ? entry : one)))
    }

    /** The transport accepted it, so from here on it may have run. */
    sent(id: string, at: number): void {
        const held = this.byId.get(id)
        // Only from `issued`: a reply can beat the transport's own acknowledgement, and a call that
        // has already succeeded must not be walked backwards into being merely sent.
        if (held?.status === 'issued') this.advance(id, { status: 'sent', sentAt: at })
    }

    /**
     * It answered. `settled` where the answer is the answer, `deferred` where it is a ticket and the
     * work is still running - which is why this takes the ticket's own promise rather than guessing
     * from the shape of a value a remote method is free to return.
     */
    resolved(id: string, at: number, deferred?: Promise<unknown>): void {
        if (!deferred) return this.advance(id, { status: 'succeeded', settledAt: at })
        this.advance(id, { status: 'deferred' })
        deferred.then(
            () => this.advance(id, { status: 'succeeded', settledAt: Date.now() }),
            (failure) => this.rejected(id, Date.now(), failure)
        )
    }

    /** It failed, and the status says whether anybody knows what it did. */
    rejected(id: string, at: number, failure: unknown): void {
        const code = (failure as { code?: RpcErrorCode } | undefined)?.code
        const message = (failure as { message?: string } | undefined)?.message
        this.advance(id, {
            status: mayHaveRun(failure) ? 'unknown-outcome' : 'failed',
            settledAt: at,
            ...(code !== undefined ? { code } : {}),
            ...(message !== undefined ? { message } : {})
        })
    }

    private publish(next: readonly RpcOperation[]) {
        this.entries = Object.freeze(next)
        for (const listener of [...this.listeners]) listener()
    }
}
