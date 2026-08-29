import { mayHaveRun } from '@source-repo/rpc'
import type { RpcActivationFence } from './Fence.js'
import {
    RpcObligationLedger,
    type RpcClockKind,
    type RpcTimerObligation,
    type RpcTimerPolicy
} from './Obligations.js'

/**
 * Doing the work and recording it are one act.
 *
 * The ledger is complete only for what went through it, and the previous way to get something into
 * it was to do the thing and then say so. Those are two acts, and everything that can go wrong with
 * two acts does: the send happens and the register does not, so the manifest is missing a command
 * that is out; the timer fires and nothing completes it, so the successor is handed a deadline that
 * has already passed; the second call is written six months later by somebody who did not know
 * about the first. A manifest that is *nearly* complete is worse than none, because the successor is
 * told it assumed everything.
 *
 * So this is not a wrapper for tidiness. **A managed timer cannot be an unregistered timer**, and a
 * managed command cannot be an unregistered command, because there is no order of statements in
 * which one happens and the other does not. What is left outside is a raw `setInterval`, a socket
 * callback, a promise chain nobody dispatched - and those are exactly what
 * `RpcOnlineChangeProfile.runtimeManagedObligations` is a claim about. This is how a revision comes
 * to be able to make that claim truthfully; it is still the revision that makes it.
 *
 * The second thing it does is less obvious and matters more. **A managed timer's callback runs on
 * the component's serial chain**, through `RpcServerHandler.runInOrder`, rather than wherever the
 * event loop happens to deliver it. A `setTimeout` that fires during a capture writes state after
 * the component was declared quiescent, and the snapshot then describes an instant that never
 * existed - values from after the barrier under a logical input position from before it. Dispatched
 * through the chain, a timer that fires while a barrier is held simply queues behind it, stays in
 * the manifest as the outstanding thing it is, and lets the successor's declared policy decide what
 * a missed deadline meant.
 */

/** What this runtime puts work onto: the same chain an instance's calls run on. */
export interface RpcSerialDispatcher {
    runInOrder<T>(path: string, run: () => T | Promise<T>): Promise<T>
}

/** Dispatch onto one exposed instance's chain. `dispatchOn(server.rpc, 'mixer')`. */
export const dispatchOn =
    (handler: RpcSerialDispatcher, path: string) =>
    (run: () => Promise<void>): Promise<void> =>
        handler.runInOrder(path, run)

export interface RpcManagedRuntimeOptions {
    /** Which component this is holding work for. Named only so a refusal says whose. */
    readonly componentId: string
    /**
     * Where the component's own work is run.
     *
     * `dispatchOn(server.rpc, 'mixer')` in a server; a plain `(run) => run()` in a test that is not
     * testing ordering. Anything that does not put the work on the same chain as the calls gives up
     * the property that makes a capture consistent, so a component whose dispatch is `run => run()`
     * in production is not eligible for online change however green its tests are.
     */
    readonly dispatch: (run: () => Promise<void>) => Promise<void>
    /**
     * The clock deadlines are measured against, reading **milliseconds**, because `afterMs` is added
     * to it. Monotonic in a plant - a wall clock steps when NTP corrects it, and a dwell timer that
     * inherits that step is a bake that ends early.
     */
    readonly monotonic: () => bigint
    /** Which clock that is, recorded on every timer. They are not interchangeable, so it is stated. */
    readonly clock?: RpcClockKind
    /** Supply one to share it, or let the runtime own one. It is the same object either way. */
    readonly ledger?: RpcObligationLedger
    /**
     * The local half of the fence, if this activation has one.
     *
     * Checked before a dispatched callback runs, and it is the case the queue cannot handle on its
     * own: a timer that fired into a held barrier is still queued when the handoff commits, and
     * running it afterwards would be a retired activation touching a plant its successor now owns.
     */
    readonly fence?: RpcActivationFence
    /**
     * Where a timer callback's failure goes.
     *
     * There is no useful default. Rethrowing inside the chain would reject a queue entry nobody is
     * awaiting, and swallowing it silently is how a periodic timer stops working for a week without
     * anybody hearing about it - so the component says where its errors go, or they are dropped and
     * that is its decision rather than this file's.
     */
    readonly onError?: (id: string, failure: unknown) => void
}

/** What a managed timer is, in the terms the successor will be asked about it. */
export interface RpcManagedTimer {
    readonly id: string
    /** From now, on `monotonic`. The obligation records the deadline this produces, not this. */
    readonly afterMs: number
    /** Required, always. See `RpcTimerPolicy` - there is no default and there should not be one. */
    readonly policy: RpcTimerPolicy
    /** Re-arms itself with the same interval. `afterMs` is the interval. */
    readonly periodic?: { readonly missedTickPolicy: NonNullable<RpcTimerObligation['periodic']>['missedTickPolicy'] }
}

export interface RpcManagedCall {
    readonly id: string
    readonly target: string
    readonly method: string
    /** What repeating it costs. The field a capture rules on, so it is not optional here. */
    readonly semantics: 'query' | 'idempotent-command' | 'non-repeatable-command'
    readonly idempotencyKey?: string
}

export interface RpcManagedInboundWork {
    readonly id: string
    readonly from: string
    readonly method: string
    readonly mutating: boolean
}

export interface RpcManagedSubscription {
    readonly id: string
    readonly event: string
    readonly lastAcknowledgedSequence?: bigint
}

export interface RpcManagedLease {
    readonly id: string
    readonly issuer: string
    readonly expiresAt: bigint
    readonly issuerSupportsLogicalOwner: boolean
}

interface HeldTimer {
    handle: ReturnType<typeof setTimeout>
    obligation: RpcTimerObligation
    fire: () => void | Promise<void>
}

/**
 * One component's runtime-managed work.
 *
 * Every method here does something to the plant *and* maintains the ledger, and the ledger is what
 * `captureAtBarrier` reads. Nothing in it registers an obligation that is not also a real handle,
 * and nothing in it starts work that is not also an obligation.
 */
export class RpcManagedRuntime {
    /** What a capture request is given. The same object throughout the activation's life. */
    readonly ledger: RpcObligationLedger

    private readonly timers = new Map<string, HeldTimer>()
    private shut = false

    constructor(private readonly options: RpcManagedRuntimeOptions) {
        this.ledger = options.ledger ?? new RpcObligationLedger()
    }

    /** Whether this runtime has been closed, or its activation fenced. Either means: do not act. */
    get closed(): boolean {
        return this.shut || this.options.fence?.retired === true
    }

    /** The manifest, with every timer's remaining time measured from now. What a capture reads. */
    manifest() {
        return this.ledger.manifest(this.options.monotonic())
    }

    /**
     * Arm a timer that the successor can be asked about.
     *
     * Re-arming an id replaces what was there, rather than leaving two handles under one name: an id
     * is what a restore declaration is matched against, so two timers answering to `mix-dwell` means
     * the successor declares a policy for one of them and is handed the other.
     */
    setTimer(spec: RpcManagedTimer, fire: () => void | Promise<void>): void {
        if (this.closed) throw new Error(`${this.options.componentId} is closed and may not arm ${spec.id}: a retired activation that set a timer would wake up inside its successor's plant`)
        this.clearTimer(spec.id)
        const now = this.options.monotonic()
        const obligation: RpcTimerObligation = {
            kind: 'timer',
            id: spec.id,
            clock: this.options.clock ?? 'monotonic',
            dueAt: now + BigInt(Math.max(0, Math.round(spec.afterMs))),
            capturedAt: now,
            policy: spec.policy,
            ...(spec.periodic ? { periodic: { interval: BigInt(Math.max(0, Math.round(spec.afterMs))), missedTickPolicy: spec.periodic.missedTickPolicy } } : {})
        }
        this.ledger.register(obligation)
        // Unref'd, so a timer cannot be the reason a process will not exit. A component's timers are
        // kept alive by the server holding its socket open; a dwell that outlived the server it
        // belonged to would be keeping a process running to fire into nothing.
        const handle = setTimeout(() => this.fired(spec.id), Math.max(0, spec.afterMs))
        handle.unref?.()
        this.timers.set(spec.id, { handle, obligation, fire })
    }

    /** Disarm it. It is no longer outstanding, so it leaves the manifest. Silent if it was not there. */
    clearTimer(id: string): void {
        const held = this.timers.get(id)
        if (!held) return
        clearTimeout(held.handle)
        this.timers.delete(id)
        this.ledger.complete(id)
    }

    /**
     * It came due. What happens next goes through the chain, which is the whole point.
     *
     * **The obligation is not completed here.** Between firing and running there is a queue, and
     * while a barrier is held that queue is where the callback sits - so a capture taken in that
     * window must show the timer as outstanding, overdue, and the successor's to decide about. A
     * runtime that struck it off the moment the handle fired would hand over a manifest saying
     * nothing was pending while a callback waited to run in a process about to be retired.
     */
    private fired(id: string): void {
        void this.options
            .dispatch(async () => {
                const held = this.timers.get(id)
                // Cleared while it waited, or the activation was fenced behind it. A fenced
                // activation's queued work does not run: its successor is authoritative now, and
                // nobody knows what it has already done.
                if (!held || this.closed) return
                if (held.obligation.periodic) {
                    const now = this.options.monotonic()
                    const next: RpcTimerObligation = { ...held.obligation, dueAt: now + held.obligation.periodic.interval, capturedAt: now }
                    const handle = setTimeout(() => this.fired(id), Number(held.obligation.periodic.interval))
                    handle.unref?.()
                    this.timers.set(id, { handle, obligation: next, fire: held.fire })
                    this.ledger.register(next)
                } else {
                    // Struck off before the callback runs, not after: what the callback then starts -
                    // a command, another timer - registers itself, and an obligation completed
                    // afterwards would briefly hold both the timer and what replaced it.
                    this.timers.delete(id)
                    this.ledger.complete(id)
                }
                try {
                    await held.fire()
                } catch (failure) {
                    this.options.onError?.(id, failure)
                }
            })
            .catch((failure: unknown) => this.options.onError?.(id, failure))
    }

    /**
     * Make a call that is on the books for as long as it is out.
     *
     * **Registered before the send and completed after the answer**, and the order is the only one
     * that is safe. Registering afterwards leaves a window in which the command is in the plant and
     * in nothing else - a barrier that falls there produces a manifest that says the component owes
     * nothing while a hopper is dispensing. Registering something that then fails to send costs a
     * spurious refusal, which somebody retries.
     *
     * A failure that **may have run** leaves a `non-repeatable-command` registered on purpose. That
     * is the one case with no safe disposition: the successor can neither assume it ran nor assume
     * it did not, and the ledger is the only thing holding the fact that nobody knows. `discharge`
     * is how it leaves, once somebody or something has established what actually happened.
     */
    async call<T>(spec: RpcManagedCall, send: () => Promise<T>): Promise<T> {
        this.ledger.register({ kind: 'outbound-call', id: spec.id, target: spec.target, method: spec.method, semantics: spec.semantics, ...(spec.idempotencyKey ? { idempotencyKey: spec.idempotencyKey } : {}) })
        try {
            const answer = await send()
            this.ledger.complete(spec.id)
            return answer
        } catch (failure) {
            if (spec.semantics !== 'non-repeatable-command' || !mayHaveRun(failure)) this.ledger.complete(spec.id)
            throw failure
        }
    }

    /**
     * Somebody established what an uncertain command did. It stops being outstanding.
     *
     * Deliberately separate from `call`, and deliberately not something a timeout can do: the whole
     * content of an unknown outcome is that the program does not know, so the only thing that can
     * end one is evidence from outside it - a reconciliation read, a device that reports what it
     * did, an operator who went and looked.
     */
    discharge(id: string): void {
        this.ledger.complete(id)
    }

    /**
     * Run an inbound handler with the fact that it is running on the books.
     *
     * A mutating handler that has not finished is why a capture refuses `work-in-flight`: the values
     * and the manifest cannot describe one instant while something is still changing them. The
     * `finally` is what makes that self-clearing rather than something a handler has to remember on
     * every path out, including the ones that throw.
     */
    async handling<T>(spec: RpcManagedInboundWork, run: () => Promise<T>): Promise<T> {
        this.ledger.register({ kind: 'inbound-work', id: spec.id, from: spec.from, method: spec.method, mutating: spec.mutating })
        try {
            return await run()
        } finally {
            this.ledger.complete(spec.id)
        }
    }

    /** A feed this component is following. Re-registering with a later position is how it advances. */
    subscribed(spec: RpcManagedSubscription): void {
        this.ledger.register({ kind: 'subscription', id: spec.id, event: spec.event, ...(spec.lastAcknowledgedSequence !== undefined ? { lastAcknowledgedSequence: spec.lastAcknowledgedSequence } : {}) })
    }

    /**
     * How far the subscriber has got.
     *
     * Recorded because a re-established feed has to continue rather than reset: a successor that
     * subscribed from nothing would replay from wherever the transport starts, and a consumer would
     * see a state reset caused by nothing but the process changing.
     */
    acknowledged(id: string, sequence: bigint): void {
        const held = this.ledger.at(id)
        if (held?.kind !== 'subscription') return
        this.ledger.register({ ...held, lastAcknowledgedSequence: sequence })
    }

    unsubscribed(id: string): void {
        this.ledger.complete(id)
    }

    /**
     * Publish something, on the books until it is out.
     *
     * A pending publication is an output this activation produced and has not yet handed to the
     * transport. Carried across, the successor knows a sequence number was allocated; dropped, a
     * subscriber sees a gap and no explanation for it.
     */
    async publishing<T>(spec: { readonly id: string; readonly event: string; readonly sequence: bigint }, send: () => Promise<T>): Promise<T> {
        this.ledger.register({ kind: 'publication', id: spec.id, event: spec.event, sequence: spec.sequence })
        try {
            return await send()
        } finally {
            this.ledger.complete(spec.id)
        }
    }

    /** A lease held from an issuer. `issuerSupportsLogicalOwner` is the issuer's claim, not ours. */
    leased(spec: RpcManagedLease): void {
        this.ledger.register({ kind: 'lease', id: spec.id, issuer: spec.issuer, expiresAt: spec.expiresAt, issuerSupportsLogicalOwner: spec.issuerSupportsLogicalOwner })
    }

    renewed(id: string, expiresAt: bigint): void {
        const held = this.ledger.at(id)
        if (held?.kind !== 'lease') return
        this.ledger.register({ ...held, expiresAt })
    }

    released(id: string): void {
        this.ledger.complete(id)
    }

    /** Where this component has got to in an ordered stream it is responsible for continuing. */
    advanced(id: string, position: bigint): void {
        this.ledger.register({ kind: 'sequence', id, position })
    }

    /**
     * Stop acting. One way, like the fence it usually accompanies.
     *
     * Every armed handle is cleared, because a retired activation whose timers still fire is exactly
     * the failure the fence exists to prevent, arriving by a route the fence does not cover - the
     * callback would find the runtime closed and do nothing, but a process would have been kept
     * awake to discover that.
     *
     * **The ledger is not emptied.** Closing is about not acting; it is not about forgetting what
     * was owed. What this activation was holding is precisely what the successor is being handed,
     * and a runtime that cleared its manifest on the way out would answer the handoff's central
     * question with silence.
     */
    close(): void {
        this.shut = true
        for (const held of this.timers.values()) clearTimeout(held.handle)
        this.timers.clear()
    }
}
